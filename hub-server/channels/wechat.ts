/**
 * 微信通道插件 — Forge Hub
 *
 * 通过 ilink API 收发微信消息。
 * 所有状态（凭据、sync_buf、context_token、allowlist）由 Hub 管理。
 */

import { ChannelStartSkipError } from "../types.js";
import type { ChannelPlugin, ChannelStopReason, HubAPI, SendResult } from "../types.js";
import type { AccountData, WeixinMessage } from "./wechat-types.js";
import { MSG_TYPE_USER } from "./wechat-types.js";
import { getUpdates, sendText, getConfig, sendTyping } from "./wechat-ilink.js";
import { uploadAndSendMedia, sendTtsAsMp3File, downloadMediaItem } from "./wechat-media.js";
import { STATE_DIR, redactSensitive } from "../config.js";
import { ChannelHealth } from "../channel-health.js";
import { recordUnauthorizedEvidence } from "../evidence.js";
import { stripMarkdown } from "../wechat-text-utils.js";
import path from "node:path";

// ── Constants ───────────────────────────────────────────────────────────────

import { isNetworkError, SEND_RETRY_DELAY_MS } from "../send-retry.js";

const TYPING_STATUS_TYPING = 1;
const TYPING_STATUS_CANCEL = 2;
const DEDUP_CAPACITY = 500;

// ── Module State ────────────────────────────────────────────────────────────

const TYPING_AUTO_CANCEL_MS = 25_000;
const TYPING_PROACTIVE_DELAY_MS = 1_500;

let hub: HubAPI;
let account: AccountData | null = null;
let polling = false;
let shouldStop = false;
let health: ChannelHealth;

const seenMessageIds = new Set<string>();
function dedupMessage(msgId: string | undefined): boolean {
  if (!msgId) return false;
  if (seenMessageIds.has(msgId)) return true;
  seenMessageIds.add(msgId);
  if (seenMessageIds.size > DEDUP_CAPACITY) {
    const first = seenMessageIds.values().next().value!;
    seenMessageIds.delete(first);
  }
  return false;
}

// ── Typing Indicator ─────────────────────────────────────────────────────────

const typingState = new Map<string, { ticket: string; timer: ReturnType<typeof setTimeout> }>();

function startTyping(senderId: string, contextToken: string): void {
  if (!account) return;
  const { baseUrl, token } = account;
  (async () => {
    try {
      const cfg = await getConfig(baseUrl, token, senderId, contextToken);
      const ticket = cfg.typing_ticket;
      if (!ticket) return;
      await sendTyping(baseUrl, token, senderId, ticket, TYPING_STATUS_TYPING);
      const timer = setTimeout(async () => {
        typingState.delete(senderId);
        try { await sendTyping(baseUrl, token, senderId, ticket, TYPING_STATUS_CANCEL); } catch { /* best-effort */ }
      }, TYPING_AUTO_CANCEL_MS);
      typingState.set(senderId, { ticket, timer });
    } catch (err) { hub?.logError(`typing 指示器失败: ${String(err)}`); }
  })();
}

async function handleTypingBeforeSend(senderId: string, contextToken: string): Promise<() => void> {
  if (!account) return () => {};
  const { baseUrl, token } = account;
  const existing = typingState.get(senderId);
  if (existing) {
    // Reactive: typing already showing, just clear timer
    clearTimeout(existing.timer);
    typingState.delete(senderId);
    const { ticket } = existing;
    return () => { sendTyping(baseUrl, token, senderId, ticket, TYPING_STATUS_CANCEL).catch(() => {}); };
  } else {
    // Proactive: show typing briefly before sending
    try {
      const cfg = await getConfig(baseUrl, token, senderId, contextToken);
      if (cfg.typing_ticket) {
        await sendTyping(baseUrl, token, senderId, cfg.typing_ticket, TYPING_STATUS_TYPING);
        await new Promise(r => setTimeout(r, TYPING_PROACTIVE_DELAY_MS));
        const ticket = cfg.typing_ticket;
        return () => { sendTyping(baseUrl, token, senderId, ticket, TYPING_STATUS_CANCEL).catch(() => {}); };
      }
    } catch { /* best-effort */ }
    return () => {};
  }
}

// ── Content Extraction ──────────────────────────────────────────────────────

const MEDIA_DIR = path.join(STATE_DIR, "wechat", "media");
type DownloadMediaItem = typeof downloadMediaItem;
type RecordUnauthorized = typeof recordUnauthorizedEvidence;

function inferWechatContentType(msg: WeixinMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.text_item?.text) return "text";
    if (item.type === 2) return "image";
    if (item.type === 3) return "voice";
    if (item.type === 4) return "file";
    if (item.type === 5) return "video";
  }
  return "unknown";
}

async function extractContent(msg: WeixinMessage, hubApi: HubAPI, downloadMedia: DownloadMediaItem): Promise<string> {
  if (!msg.item_list?.length) return "";

  const parts: string[] = [];
  for (const item of msg.item_list) {
    // Text
    if (item.text_item?.text) {
      let text = item.text_item.text;
      if (item.ref_msg?.message_item?.text_item?.text) {
        text = `[引用: ${item.ref_msg.message_item.text_item.text}]\n${text}`;
      }
      parts.push(text);
      continue;
    }

    // Voice with ASR text
    if (item.type === 3 && item.voice_item?.text) {
      parts.push(`[语音] ${item.voice_item.text}`);
      continue;
    }

    // Media: download
    if (item.type === 2 || item.type === 3 || item.type === 4 || item.type === 5) {
      const media = await downloadMedia(item as any, MEDIA_DIR);
      if (media) {
        const labels: Record<string, string> = { image: "图片", voice: "语音文件", file: "文件", video: "视频" };
        parts.push(`[${labels[media.type]}] 已保存到 ${media.filePath}`);
        hubApi.log(`📎 ${labels[media.type]}: ${media.filePath}`);
      } else {
        const typeNames: Record<number, string> = { 2: "图片", 3: "语音", 4: "文件", 5: "视频" };
        parts.push(`[${typeNames[item.type ?? 0] || "未知媒体"}] (无法下载)`);
      }
      continue;
    }
  }

  return parts.join("\n");
}

interface HandleWechatUserMessageDeps {
  hubApi: HubAPI;
  downloadMedia?: DownloadMediaItem;
  recordUnauthorized?: RecordUnauthorized;
  startTypingFn?: (senderId: string, contextToken: string) => void;
}

async function handleWechatUserMessage(msg: WeixinMessage, deps: HandleWechatUserMessageDeps): Promise<void> {
  const hubApi = deps.hubApi;
  const senderId = msg.from_user_id ?? "unknown";

  if (!hubApi.isAllowed(senderId)) {
    const contentType = inferWechatContentType(msg);
    const recordUnauthorized: RecordUnauthorized = deps.recordUnauthorized ?? ((opts) => recordUnauthorizedEvidence(opts));
    const evidence = recordUnauthorized({
      channel: "wechat",
      ingestMode: "polling",
      updateId: msg.message_id ?? "",
      chatId: senderId,
      messageId: msg.message_id ? String(msg.message_id) : null,
      sourceUserId: senderId,
      contentType,
      contentMeta: { content_type: contentType, item_count: msg.item_list?.length ?? 0 },
      rawJson: JSON.stringify(msg),
      displayName: senderId,
      logError: (m) => hubApi.logError(m),
    });
    hubApi.recordSecurityEvent({
      sourceUserId: senderId,
      contentType,
      evidenceId: evidence?.evidence_id ?? "",
    });
    return;
  }

  const content = await extractContent(msg, hubApi, deps.downloadMedia ?? downloadMediaItem);
  if (!content) return;

  if (msg.context_token) {
    const tokens = (hubApi.getState("context-tokens") ?? {}) as Record<string, string>;
    tokens[senderId] = msg.context_token;
    hubApi.setState("context-tokens", tokens);
  }

  const nick = hubApi.getNickname(senderId);
  hubApi.log(`← ${nick}: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`);

  const startTypingForMessage = deps.startTypingFn ?? startTyping;
  startTypingForMessage(senderId, msg.context_token ?? "");

  hubApi.pushMessage({
    channel: "wechat",
    from: nick,
    fromId: senderId,
    content,
    raw: { context_token: msg.context_token ?? "" },
  });
}

export const __test__ = {
  inferWechatContentType,
  handleWechatUserMessage,
};

// ── Chat History ────────────────────────────────────────────────────────────

// History is now written by Hub layer (hub.ts onMessage/send)

// ── Polling Loop ────────────────────────────────────────────────────────────

type WechatErrorClassification =
  | { fatal: false }
  | { fatal: true; reason: string; stoppedReason: ChannelStopReason };

/** 简版 classifyError：auth 错误立刻停止（无限 retry 无意义），其他算可重试 */
function classifyWechatError(errmsg: string, errcode?: number): WechatErrorClassification {
  const lower = (errmsg ?? "").toLowerCase();
  if (errcode === 401 || lower.includes("token") || lower.includes("auth") || lower.includes("unauthorized")) {
    return { fatal: true, reason: "auth/token 失效", stoppedReason: "auth" };
  }
  return { fatal: false };
}

async function startPolling(): Promise<void> {
  if (!account) return;
  polling = true;
  shouldStop = false;

  const { baseUrl, token } = account;
  let syncBuf = ((hub.getState("sync") as { buf?: string })?.buf) ?? "";

  hub.log("开始监听微信消息...");

  while (!shouldStop) {
    try {
      const resp = await getUpdates(baseUrl, token, syncBuf);

      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isError) {
        const errMsg = resp.errmsg ?? "";

        const classified = classifyWechatError(errMsg, resp.errcode);
        if (classified.fatal) {
          hub.logError(`💀 不可恢复错误（${classified.reason}）: ret=${resp.ret} errcode=${resp.errcode} errmsg=${errMsg}。停止微信轮询。`);
          plugin.stoppedReason = classified.stoppedReason;
          break;
        }

        if (!health.isDormant()) {
          hub.logError(`getupdates 失败: ret=${resp.ret} errcode=${resp.errcode} errmsg=${errMsg}`);
        }

        const delay = await health.onFailure();
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      health.onSuccess();

      if (resp.get_updates_buf) {
        syncBuf = resp.get_updates_buf;
        hub.setState("sync", { buf: syncBuf });
      }

      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;
        if (dedupMessage(msg.message_id)) continue;

        await handleWechatUserMessage(msg, { hubApi: hub });
      }
    } catch (err) {
      if (!health.isDormant()) {
        hub.logError(`轮询异常: ${String(err)}`);
      }
      const delay = await health.onFailure();
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  polling = false;
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: ChannelPlugin = {
  name: "wechat",
  displayName: "微信",
  aliases: ["wx"],
  capabilities: ["text", "file", "voice", "image"],
  formatHints: "纯文本。不支持 Markdown（会被自动 strip）。长消息自动分段（3500字符/段）。语音以 mp3 附件发送，非原生语音条。",
  isNativeId(to) { return to.includes("@im.wechat"); },

  async start(hubAPI) {
    hub = hubAPI;

    account = hub.getState("account") as AccountData | null;
    if (!account?.token || !account?.baseUrl) {
      hub.logError("未找到微信凭据。请先在 ~/.forge-hub/state/wechat/account.json 配置");
      throw new ChannelStartSkipError("未配置微信 account.json");
    }

    health = new ChannelHealth({
      name: "wechat",
      onRestart: async () => {
        hub.log("[wechat] 完整重启：stop polling → restart");
        shouldStop = true;
        let wait = 0;
        while (polling && wait < 80) { await new Promise(r => setTimeout(r, 500)); wait++; }
        startPolling();
      },
      log: (msg) => hub.log(msg),
    });

    hub.log(`账号: ${account.accountId}`);
    startPolling();
  },

  async send({ to, content, type, filePath, raw }): Promise<SendResult> {
    if (!account) {
      return { success: false, error: "未登录" };
    }

    if (health?.isDormant()) {
      const woke = await health.onOutboundRequest();
      if (!woke) return { success: false, error: "通道恢复冷却中，稍后重试" };
    }

    const contextToken = (raw?.context_token as string) ?? "";
    const cancelTyping = await handleTypingBeforeSend(to, contextToken);

    try {
      if (type === "text") {
        const cleaned = stripMarkdown(content);
        await sendText(account.baseUrl, account.token, to, cleaned, contextToken);
        hub.log(`→ ${to.slice(0, 16)}...: ${cleaned.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "file" && filePath) {
        await uploadAndSendMedia(account.baseUrl, account.token, to, filePath, contextToken, MEDIA_DIR);
        hub.log(`→ 文件: ${filePath.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "voice") {
        await sendTtsAsMp3File(account.baseUrl, account.token, to, content, contextToken, MEDIA_DIR);
        hub.log(`→ 语音(mp3 附件): "${content.slice(0, 30)}..."`);
        return { success: true };
      }

      return { success: false, error: `unknown type: ${type}` };
    } catch (err) {
      const raw = String(err);
      if (isNetworkError(raw)) {
        hub.logError(`发送失败（网络），${SEND_RETRY_DELAY_MS / 1000}s 后重试: ${redactSensitive(raw)}`);
        await new Promise(r => setTimeout(r, SEND_RETRY_DELAY_MS));
        try {
          if (type === "text") {
            await sendText(account.baseUrl, account.token, to, stripMarkdown(content), contextToken);
          } else if (type === "file" && filePath) {
            await uploadAndSendMedia(account.baseUrl, account.token, to, filePath, contextToken, MEDIA_DIR);
          } else if (type === "voice") {
            await sendTtsAsMp3File(account.baseUrl, account.token, to, content, contextToken, MEDIA_DIR);
          }
          hub.log(`→ 重试成功`);
          return { success: true };
        } catch (retryErr) {
          hub.logError(`重试也失败: ${redactSensitive(String(retryErr))}`);
          return { success: false, error: `[微信通道] 发送失败——Hub 到 iLink 服务器的连接中断。已重试 1 次仍未恢复，建议稍后重试。` };
        }
      }
      if (raw.includes("sendmessage 失败")) {
        return { success: false, error: `[微信通道] 发送被 iLink 拒绝（${redactSensitive(raw)}）——可能需要重新扫码登录。` };
      }
      return { success: false, error: `[微信通道] 发送失败——${redactSensitive(raw)}` };
    } finally {
      cancelTyping();
    }
  },

  async stop() {
    shouldStop = true;
    hub.log("停止微信轮询...");
    // Wait for polling to finish current iteration
    let waitCount = 0;
    while (polling && waitCount < 40) {
      await new Promise((r) => setTimeout(r, 1000));
      waitCount++;
    }
  },
};

export default plugin;
