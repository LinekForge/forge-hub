/**
 * iMessage 通道插件 — Forge Hub
 *
 * 直接读 ~/Library/Messages/chat.db (SQLite) + AppleScript 发消息。
 * 零外部依赖，零网络。参考 anthropics/claude-plugins-official/imessage。
 *
 * 需要权限：
 * - Full Disk Access（读 chat.db）
 * - Automation（控制 Messages.app）
 */

import { ChannelStartSkipError } from "../types.js";
import type { ChannelPlugin, HubAPI, SendResult } from "../types.js";
import { redactSensitive } from "../config.js";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Constants ───────────────────────────────────────────────────────────────

const CHAT_DB = join(homedir(), "Library", "Messages", "chat.db");
const POLL_INTERVAL_MS = 1000;
const ECHO_WINDOW_MS = 15000;
// 连续 MAX_CONSECUTIVE_FAILURES 次 poll 抛错 → 停 interval 避免空转淹日志。
// 选 30 是因为 imessage 是本地 SQLite，连错 30 次（约 30s）通常是 chat.db 丢权限/损坏，retry 无意义。
const MAX_CONSECUTIVE_FAILURES = 30;

// ── Module State ────────────────────────────────────────────────────────────

let hub: HubAPI;
let db: Database | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let watermark = 0;
let consecutiveFailures = 0;

// ── Allowlist ───────────────────────────────────────────────────────────────

import type { Allowlist } from "../types.js";  // 统一 schema，详见 types.ts::Allowlist

function getAllowlist(): Allowlist {
  return (hub.getState("allowlist") ?? { allowed: [], auto_allow_next: false }) as Allowlist;
}

function isAllowed(handleId: string): boolean {
  return getAllowlist().allowed.some((e) => e.id.toLowerCase() === handleId.toLowerCase());
}

function getNickname(handleId: string): string {
  const entry = getAllowlist().allowed.find((e) => e.id.toLowerCase() === handleId.toLowerCase());
  return entry?.nickname ?? handleId;
}

// ── Self Address Detection ──────────────────────────────────────────────────

const selfAddresses = new Set<string>();

function detectSelfAddresses(): void {
  if (!db) return;
  const norm = (s: string) => (/^[A-Za-z]:/.test(s) ? s.slice(2) : s).toLowerCase();
  try {
    const accounts = db.query<{ addr: string }, []>(
      "SELECT DISTINCT account AS addr FROM message WHERE is_from_me = 1 AND account IS NOT NULL AND account != '' LIMIT 50"
    ).all();
    for (const { addr } of accounts) selfAddresses.add(norm(addr));

    const handles = db.query<{ addr: string }, []>(
      "SELECT DISTINCT last_addressed_handle AS addr FROM chat WHERE last_addressed_handle IS NOT NULL AND last_addressed_handle != '' LIMIT 50"
    ).all();
    for (const { addr } of handles) selfAddresses.add(norm(addr));
  } catch (err) {
    // 自身地址查询失败 → echo 过滤会失效 → agent 收到自己发的消息再回传 → 死循环风险
    hub.logError(`iMessage 自身地址查询失败（echo 过滤将失效）: ${String(err)}`);
  }
  hub.log(`自身地址: ${[...selfAddresses].join(", ") || "(无)"}`);
}

// ── Echo Filter (self-chat) ─────────────────────────────────────────────────

const echoMap = new Map<string, number>();

function echoKey(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 120);
}

function trackEcho(chatGuid: string, key: string): void {
  const now = Date.now();
  for (const [k, t] of echoMap) if (now - t > ECHO_WINDOW_MS) echoMap.delete(k);
  echoMap.set(`${chatGuid}\x00${echoKey(key)}`, now);
}

function consumeEcho(chatGuid: string, key: string): boolean {
  const k = `${chatGuid}\x00${echoKey(key)}`;
  const t = echoMap.get(k);
  if (t == null || Date.now() - t > ECHO_WINDOW_MS) return false;
  echoMap.delete(k);
  return true;
}

// ── attributedBody Parser ───────────────────────────────────────────────────

function parseAttributedBody(blob: Uint8Array | null): string | null {
  if (!blob) return null;
  const buf = Buffer.from(blob);
  let i = buf.indexOf("NSString");
  if (i < 0) return null;
  i += "NSString".length;
  while (i < buf.length && buf[i] !== 0x2b) i++;
  if (i >= buf.length) return null;
  i++;
  let len: number;
  const b = buf[i++];
  if (b === 0x81) { len = buf[i]; i += 1; }
  else if (b === 0x82) { len = buf.readUInt16LE(i); i += 2; }
  else if (b === 0x83) { len = buf.readUIntLE(i, 3); i += 3; }
  else { len = b; }
  if (i + len > buf.length) return null;
  return buf.toString("utf8", i, i + len);
}

// ── Chat History ────────────────────────────────────────────────────────────

// History is now written by Hub layer (hub.ts onMessage/send)

// ── Sending ─────────────────────────────────────────────────────────────────

const SEND_SCRIPT = `on run argv
  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)
end run`;

const SEND_FILE_SCRIPT = `on run argv
  tell application "Messages" to send (POSIX file (item 1 of argv)) to chat id (item 2 of argv)
end run`;

function sendIMessage(chatGuid: string, text: string): string | null {
  const res = spawnSync("osascript", ["-", text, chatGuid], {
    input: SEND_SCRIPT,
    encoding: "utf8",
  });
  if (res.status !== 0) return res.stderr.trim() || `osascript exit ${res.status}`;
  trackEcho(chatGuid, text);
  return null;
}

function sendFile(chatGuid: string, filePath: string): string | null {
  const res = spawnSync("osascript", ["-", filePath, chatGuid], {
    input: SEND_FILE_SCRIPT,
    encoding: "utf8",
  });
  if (res.status !== 0) return res.stderr.trim() || `osascript exit ${res.status}`;
  trackEcho(chatGuid, "\x00att");
  return null;
}

// ── Polling ─────────────────────────────────────────────────────────────────

type MessageRow = {
  rowid: number;
  text: string | null;
  attributedBody: Uint8Array | null;
  date: number;
  is_from_me: number;
  cache_has_attachments: number;
  handle_id: string | null;
  chat_guid: string;
  chat_style: number | null;
};

async function poll(): Promise<void> {
  // 外层 isolation：setInterval 回调里的同步/异步 throw 都不能冒到 process uncaughtException。
  // pollInner 改 async 是因为 audio attachment 要 await hub.resolveAsr（Hub 层 ASR）。
  try {
    await pollInner();
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    hub.logError(`poll 外层异常 #${consecutiveFailures}: ${String(err)}`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      hub.logError(`💀 iMessage 轮询连续失败 ${consecutiveFailures} 次，停止 (chat.db 可能丢权限或损坏)`);
      plugin.stoppedReason = String(err).includes("SQLITE_READONLY") || String(err).includes("permission") ? "config" : "cap_reached";
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }
  }
}

async function pollInner(): Promise<void> {
  if (!db) return;
  let rows: MessageRow[];
  try {
    rows = db.query<MessageRow, [number]>(`
      SELECT m.ROWID AS rowid, m.text, m.attributedBody, m.date, m.is_from_me,
             m.cache_has_attachments, h.id AS handle_id, c.guid AS chat_guid, c.style AS chat_style
      FROM message m
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      JOIN chat c ON c.ROWID = cmj.chat_id
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
    `).all(watermark);
  } catch (err) {
    hub.logError(`查询异常: ${String(err)}`);
    throw err;  // 冒到 poll 外层累计 consecutiveFailures
  }

  for (const r of rows) {
    watermark = r.rowid;

    // Skip own sends
    if (r.is_from_me) continue;
    if (!r.handle_id || !r.chat_guid) continue;

    // Only DMs (style 45)
    const isGroup = r.chat_style === 43;
    const sender = r.handle_id;

    const text = r.text ?? parseAttributedBody(r.attributedBody) ?? "";
    if (!text && !r.cache_has_attachments) continue;

    // Self-chat echo filter
    const isSelfChat = !isGroup && selfAddresses.has(sender.toLowerCase());
    if (isSelfChat && consumeEcho(r.chat_guid, text || "\x00att")) continue;

    // Allowlist check (self-chat bypasses)
    if (!isSelfChat) {
      if (!isAllowed(sender)) {
        hub.logError(`⛔ 拒绝未授权: ${sender}, 原文前 50: "${(text || "[非文本]").slice(0, 50)}"`);
        hub.pushMessage({
          channel: "imessage",
          from: "system",
          fromId: "system",
          content: hub.formatUnauthorizedNotice(sender, sender, text || "[非文本]"),
          raw: {},
        });
        continue;
      }
    }

    const displayName = isSelfChat ? "用户（自聊）" : getNickname(sender);

    // Extract attachment file paths from chat.db
    let attachmentInfo = "";
    if (r.cache_has_attachments && db) {
      try {
        const atts = db.query<{ filename: string | null; mime_type: string | null }, [number]>(`
          SELECT a.filename, a.mime_type FROM attachment a
          JOIN message_attachment_join maj ON a.ROWID = maj.attachment_id
          WHERE maj.message_id = ?
        `).all(r.rowid);
        const parts: string[] = [];
        for (const att of atts) {
          if (!att.filename) continue;
          // Resolve ~/Library/... paths
          const filePath = att.filename.startsWith("~/")
            ? join(homedir(), att.filename.slice(2))
            : att.filename;
          const isImage = att.mime_type?.startsWith("image/");
          const isAudio = att.mime_type?.startsWith("audio/");
          if (isAudio) {
            // Hub 层 ASR：plugin 没实现则走 FORGE_HUB_ASR_HOOK；都没则给 path 占位
            const text = await hub.resolveAsr(filePath);
            parts.push(text ? `[语音] ${text}` : `[语音] ${filePath}`);
          } else {
            const label = isImage ? "图片" : "文件";
            parts.push(`[${label}] ${filePath}`);
          }
        }
        if (parts.length > 0) attachmentInfo = parts.join("\n");
      } catch {}
    }

    const content = [text, attachmentInfo].filter(Boolean).join("\n") || "[附件]";

    hub.log(`← ${displayName}: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`);

    hub.pushMessage({
      channel: "imessage",
      from: displayName,
      fromId: r.chat_guid, // use chat_guid as ID (needed for reply)
      content,
      raw: { handle_id: sender, is_group: isGroup },
    });

    // History recorded by Hub layer
  }
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: ChannelPlugin = {
  name: "imessage",
  displayName: "iMessage",
  aliases: ["im"],
  capabilities: ["text", "file", "image"],
  // iMessage chat_guid contains ";-;", otherwise it's phone/email (native too
  // but handled as nickname fallback returns the raw string)
  isNativeId(to) { return to.includes(";-;") || /^\+\d{5,}$/.test(to) || /@/.test(to); },

  async start(hubAPI) {
    hub = hubAPI;

    // Open chat.db
    try {
      db = new Database(CHAT_DB, { readonly: true });
      db.run("PRAGMA busy_timeout = 5000");
      db.query("SELECT ROWID FROM message LIMIT 1").get();
    } catch (err) {
      hub.logError(`无法读取 ${CHAT_DB}: ${String(err)}`);
      hub.logError("需要 Full Disk Access 权限（系统设置 → 隐私与安全 → 完全磁盘访问权限）");
      throw new ChannelStartSkipError("无法读取 iMessage chat.db（通常是缺 Full Disk Access）");
    }

    // Detect self addresses
    detectSelfAddresses();

    // Start at current max ROWID (only new messages)
    const row = db.query<{ max: number | null }, []>("SELECT MAX(ROWID) AS max FROM message").get();
    watermark = row?.max ?? 0;
    hub.log(`监听 chat.db (watermark=${watermark})`);

    // Start polling
    pollTimer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
    hub.log("iMessage 通道已启动");
  },

  async send({ to, content, type, filePath }): Promise<SendResult> {
    // `to` is chat_guid (e.g. "iMessage;-;+1555...")
    try {
      if (type === "text") {
        const err = sendIMessage(to, content);
        if (err) return { success: false, error: err };
        hub.log(`→ ${to.slice(0, 30)}...: ${content.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "file" && filePath) {
        const err = sendFile(to, filePath);
        if (err) return { success: false, error: err };
        hub.log(`→ 文件: ${filePath.slice(0, 60)}`);
        return { success: true };
      }

      return { success: false, error: `不支持的类型: ${type}` };
    } catch (err) {
      const redacted = redactSensitive(String(err));
      hub.logError(`发送失败 (type=${type}): ${redacted}`);
      return { success: false, error: redacted };
    }
  },

  async stop() {
    if (pollTimer) clearInterval(pollTimer);
    if (db) {
      try { db.close(); } catch {}
    }
    hub.log("iMessage 通道已停止");
  },
};

export default plugin;
