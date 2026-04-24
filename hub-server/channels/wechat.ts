/**
 * 微信通道插件 — Forge Hub
 *
 * 通过 ilink API 收发微信消息。
 * 所有状态（凭据、sync_buf、context_token、allowlist）由 Hub 管理。
 */

import { ChannelStartSkipError } from "../types.js";
import type { ChannelPlugin, HubAPI, SendParams, SendResult } from "../types.js";
import type { AccountData, Allowlist, WeixinMessage } from "./wechat-types.js";
import { MSG_TYPE_USER } from "./wechat-types.js";
import { getUpdates, sendText, getConfig, sendTyping } from "./wechat-ilink.js";
import { uploadAndSendMedia, sendTtsAsMp3File, downloadMediaItem } from "./wechat-media.js";
import { redactSensitive } from "../config.js";

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_CONSECUTIVE_FAILURES = 3;
// 连续 FAILURE_CAP 次失败彻底停止轮询——避免 ilink 长期挂了无限 retry 淹日志 + 糟蹋 CPU。
// 选 60：以 backoff 30s × 60 = 30 分钟。用户在 30 min 内会通过其他通道得知 Hub 异常。
const FAILURE_CAP = 60;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const TYPING_STATUS_TYPING = 1;
const TYPING_STATUS_CANCEL = 2;

// ── Module State ────────────────────────────────────────────────────────────

const TYPING_AUTO_CANCEL_MS = 25_000;
const TYPING_PROACTIVE_DELAY_MS = 1_500;

let hub: HubAPI;
let account: AccountData | null = null;
let polling = false;
let shouldStop = false;

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
        try { await sendTyping(baseUrl, token, senderId, ticket, TYPING_STATUS_CANCEL); } catch {}
      }, TYPING_AUTO_CANCEL_MS);
      typingState.set(senderId, { ticket, timer });
    } catch {}
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
    } catch {}
    return () => {};
  }
}

// ── Allowlist ───────────────────────────────────────────────────────────────

function isAllowed(senderId: string): boolean {
  const allowlist = (hub.getState("allowlist") ?? { allowed: [], auto_allow_next: false }) as Allowlist;
  return allowlist.allowed.some((e) => e.id === senderId);
}

function getNickname(senderId: string): string {
  const allowlist = (hub.getState("allowlist") ?? { allowed: [] }) as Allowlist;
  const entry = allowlist.allowed.find((e) => e.id === senderId);
  return entry?.nickname ?? senderId.split("@")[0];
}

// ── Content Extraction ──────────────────────────────────────────────────────

const MEDIA_DIR = `${process.env.HOME}/.forge-hub/state/wechat/media`;

async function extractContent(msg: WeixinMessage): Promise<string> {
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
      const media = await downloadMediaItem(item as any, MEDIA_DIR);
      if (media) {
        const labels: Record<string, string> = { image: "图片", voice: "语音文件", file: "文件", video: "视频" };
        parts.push(`[${labels[media.type]}] 已保存到 ${media.filePath}`);
        hub.log(`📎 ${labels[media.type]}: ${media.filePath}`);
      } else {
        const typeNames: Record<number, string> = { 2: "图片", 3: "语音", 4: "文件", 5: "视频" };
        parts.push(`[${typeNames[item.type ?? 0] || "未知媒体"}] (无法下载)`);
      }
      continue;
    }
  }

  return parts.join("\n");
}

// ── Chat History ────────────────────────────────────────────────────────────

// History is now written by Hub layer (hub.ts onMessage/send)

// ── Polling Loop ────────────────────────────────────────────────────────────

/** 简版 classifyError：auth 错误立刻停止（无限 retry 无意义），其他算可重试 */
function classifyWechatError(errmsg: string, errcode?: number): { fatal: boolean; reason?: string } {
  const lower = (errmsg ?? "").toLowerCase();
  if (errcode === 401 || lower.includes("token") || lower.includes("auth") || lower.includes("unauthorized")) {
    return { fatal: true, reason: "auth/token 失效" };
  }
  return { fatal: false };
}

async function startPolling(): Promise<void> {
  if (!account) return;
  polling = true;
  shouldStop = false;

  const { baseUrl, token } = account;
  let syncBuf = ((hub.getState("sync") as { buf?: string })?.buf) ?? "";
  let consecutiveFailures = 0;
  let totalFailures = 0;

  hub.log("开始监听微信消息...");

  while (!shouldStop) {
    try {
      const resp = await getUpdates(baseUrl, token, syncBuf);

      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isError) {
        consecutiveFailures++;
        totalFailures++;
        const errMsg = resp.errmsg ?? "";

        // 分类：auth 错误立刻停止——无限 retry 无益
        const classified = classifyWechatError(errMsg, resp.errcode);
        if (classified.fatal) {
          hub.logError(`💀 不可恢复错误（${classified.reason}）: ret=${resp.ret} errcode=${resp.errcode} errmsg=${errMsg}。停止微信轮询。`);
          plugin.stoppedReason = classified.reason === "token" ? "auth" : "config";
          break;
        }

        hub.logError(`getupdates 失败: ret=${resp.ret} errcode=${resp.errcode} errmsg=${errMsg}`);

        // Hard cap：连续失败达上限彻底放弃
        if (totalFailures >= FAILURE_CAP) {
          hub.logError(`💀 微信轮询累计失败 ${totalFailures} 次达上限，停止`);
          plugin.stoppedReason = "cap_reached";
          break;
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
        } else {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }

      consecutiveFailures = 0;
      totalFailures = 0;  // 成功轮询重置 hard cap

      // Save sync buffer
      if (resp.get_updates_buf) {
        syncBuf = resp.get_updates_buf;
        hub.setState("sync", { buf: syncBuf });
      }

      // Process messages
      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== MSG_TYPE_USER) continue;

        const content = await extractContent(msg);
        if (!content) continue;

        const senderId = msg.from_user_id ?? "unknown";

        // Update context token
        if (msg.context_token) {
          const tokens = (hub.getState("context-tokens") ?? {}) as Record<string, string>;
          tokens[senderId] = msg.context_token;
          hub.setState("context-tokens", tokens);
        }

        // Check allowlist — 非主人拒收 + push system 告警（本阶段 allowlist 只有用户，任何非主人消息都是风险事件）
        if (!isAllowed(senderId)) {
          hub.logError(`⛔ 拒绝未授权 sender: ${senderId}, 内容前 50 字符: "${content.slice(0, 50)}"`);
          hub.pushMessage({
            channel: "wechat",
            from: "system",
            fromId: "system",
            content: hub.formatUnauthorizedNotice(senderId, senderId, content),
            raw: {},
          });
          continue;
        }

        const nick = getNickname(senderId);
        hub.log(`← ${nick}: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`);

        // Start typing indicator
        startTyping(senderId, msg.context_token ?? "");

        // Push to Hub
        hub.pushMessage({
          channel: "wechat",
          from: nick,
          fromId: senderId,
          content,
          raw: { context_token: msg.context_token ?? "" },
        });

        // Record chat history
        // History recorded by Hub layer
      }
    } catch (err) {
      consecutiveFailures++;
      totalFailures++;
      hub.logError(`轮询异常: ${String(err)}`);
      if (totalFailures >= FAILURE_CAP) {
        hub.logError(`💀 微信轮询累计异常 ${totalFailures} 次达上限，停止`);
        plugin.stoppedReason = "cap_reached";
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await new Promise((r) => setTimeout(r, BACKOFF_DELAY_MS));
      } else {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
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
  isNativeId(to) { return to.includes("@im.wechat"); },

  async start(hubAPI) {
    hub = hubAPI;

    // Load credentials
    account = hub.getState("account") as AccountData | null;
    if (!account?.token || !account?.baseUrl) {
      hub.logError("未找到微信凭据。请先在 ~/.forge-hub/state/wechat/account.json 配置");
      throw new ChannelStartSkipError("未配置微信 account.json");
    }

    hub.log(`账号: ${account.accountId}`);

    // Start polling (non-blocking)
    startPolling();
  },

  async send({ to, content, type, filePath, raw }): Promise<SendResult> {
    if (!account) {
      return { success: false, error: "未登录" };
    }

    const contextToken = (raw?.context_token as string) ?? "";

    try {
      // Handle typing indicator before sending
      const cancelTyping = await handleTypingBeforeSend(to, contextToken);

      if (type === "text") {
        await sendText(account.baseUrl, account.token, to, content, contextToken);
        cancelTyping();
        hub.log(`→ ${to.slice(0, 16)}...: ${content.slice(0, 60)}`);
        // History recorded by Hub layer
        return { success: true };
      }

      if (type === "file" && filePath) {
        const mediaDir = `${process.env.HOME}/.forge-hub/state/wechat/media`;
        await uploadAndSendMedia(account.baseUrl, account.token, to, filePath, contextToken, mediaDir);
        cancelTyping();
        hub.log(`→ 文件: ${filePath.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "voice") {
        const mediaDir = `${process.env.HOME}/.forge-hub/state/wechat/media`;
        // 微信 iLink 不接原生 silk 语音（静默吞）——降级为 mp3 附件文件
        // 详见 wechat-media.ts `sendTtsAsMp3File` 的注释
        await sendTtsAsMp3File(account.baseUrl, account.token, to, content, contextToken, mediaDir);
        cancelTyping();
        hub.log(`→ 语音(mp3 附件): "${content.slice(0, 30)}..."`);
        return { success: true };
      }

      return { success: false, error: `unknown type: ${type}` };
    } catch (err) {
      const redacted = redactSensitive(String(err));
      hub.logError(`发送失败: ${redacted}`);
      return { success: false, error: redacted };
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
