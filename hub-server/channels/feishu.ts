/**
 * 飞书通道插件 — Forge Hub
 *
 * 通过 @larksuiteoapi/node-sdk 直连飞书 WebSocket，收发消息。
 * 零子进程，连接生命周期完全在 Hub 进程内。
 */

import type { ChannelPlugin, HubAPI, SendResult } from "../types.js";
import { STATE_DIR, redactSensitive } from "../config.js";
import { ChannelHealth } from "../channel-health.js";
import fs from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertRealPathInsideDir, sanitizeMediaFileName } from "../media-path.js";
import { assertFileWithinMediaSizeLimit } from "../media-policy.js";
import { recordUnauthorizedEvidence } from "../evidence.js";
import { isNetworkError, SEND_RETRY_DELAY_MS } from "../send-retry.js";

// ── Constants ───────────────────────────────────────────────────────────────

const FEISHU_MEDIA_DIR = join(STATE_DIR, "feishu", "media");
const KEYCHAIN_SERVICE = "lark-cli/appsecret";

// ── Module State ────────────────────────────────────────────────────────────

let hub: HubAPI;
let health: ChannelHealth;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK 动态加载
let Lark: any = null;
let client: any = null;
let wsClient: any = null;
let readyReported = false;

// ── Credentials ─────────────────────────────────────────────────────────────

function readAppSecret(appId: string): string | null {
  try {
    return execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", appId, "-w"],
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
  } catch {
    return null;
  }
}

function loadFeishuConfig(): { appId: string; appSecret: string } | null {
  const config = hub.getState("config") as { app_id?: string; app_secret?: string } | null;
  const appId = config?.app_id ?? process.env.FORGE_FEISHU_APP_ID ?? "";
  if (!appId) return null;

  const appSecret = config?.app_secret ?? process.env.FORGE_FEISHU_APP_SECRET ?? readAppSecret(appId) ?? "";
  if (!appSecret) return null;

  return { appId, appSecret };
}

// ── Media Download ──────────────────────────────────────────────────────────

async function downloadFeishuMedia(
  messageId: string,
  type: "image" | "file",
  fileKey: string,
  fileName?: string,
): Promise<string | null> {
  if (!fileKey || !messageId || !client) return null;
  let fullPath = "";
  try {
    await fs.promises.mkdir(FEISHU_MEDIA_DIR, { recursive: true });
    const outputName = sanitizeMediaFileName(fileName ?? `${type}.${type === "image" ? "png" : "dat"}`);
    fullPath = join(FEISHU_MEDIA_DIR, outputName);

    const resp = await client.im.v1.messageResource.get({
      params: { type },
      path: { message_id: messageId, file_key: fileKey },
    });
    await resp.writeFile(fullPath);

    await assertRealPathInsideDir(FEISHU_MEDIA_DIR, fullPath);
    await assertFileWithinMediaSizeLimit(fullPath, `Feishu 媒体 ${outputName}`);
    hub.log(`📎 下载: ${outputName}`);
    return fullPath;
  } catch (err) {
    if (fullPath) await fs.promises.unlink(fullPath).catch(() => {});
    hub.logError(`媒体下载失败: ${String(err)}`);
    return null;
  }
}

// ── Content Parsing ─────────────────────────────────────────────────────────

function parseContentJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

// ── Post 富文本解析（导出，供测试） ─────────────────────────────────────────

/**
 * 从飞书 post 消息的富文本 JSON 里提取文字 + 文件。
 *
 * post 消息 content 形如：
 *   {"title":"","content":[[{"tag":"text","text":"..."},{"tag":"file","file_key":"...","file_name":"..."}]]}
 * 只取文字时文件信息整个丢，文件不落盘。这里按序拼接 text，并把 file 下载成
 * `[文件] 路径`。download 参数注入，便于测试 mock。
 *
 * @param contentJson 消息原始 content 字符串
 * @param download    下载回调 (fileKey, fileName) => 落盘路径或 null
 * @returns 拼接后的文本（空 content / 解析失败时返回空串）
 */
export function extractFeishuPostParts(
  contentJson: string,
  download: (fileKey: string, fileName?: string) => Promise<string | null>,
): Promise<string> {
  return (async () => {
    const parsed = parseContentJson(contentJson);
    const contentArr = parsed.content;
    if (!Array.isArray(contentArr)) return (parsed.text as string) ?? "";

    const parts: string[] = [];
    for (const row of contentArr) {
      if (!Array.isArray(row)) continue;
      for (const el of row) {
        if (typeof el !== "object" || el === null) continue;
        const tag = (el as Record<string, unknown>).tag as string | undefined;
        if (tag === "text") {
          const t = (el as Record<string, unknown>).text as string | undefined;
          if (t) parts.push(t);
        } else if (tag === "file" || tag === "file_v2") {
          const fileKey = (el as Record<string, unknown>).file_key as string | undefined;
          const fileName = (el as Record<string, unknown>).file_name as string | undefined;
          if (fileKey) {
            const filePath = await download(fileKey, fileName ?? "file");
            parts.push(filePath ? `[文件] ${filePath}` : `[文件: ${fileName ?? "file"}]`);
          }
        }
      }
    }
    return parts.length > 0 ? parts.join("\n") : ((parsed.text as string) ?? "");
  })();
}

// ── Message Handler ─────────────────────────────────────────────────────────

async function handleMessage(data: Record<string, unknown>): Promise<void> {
  const message = data.message as Record<string, unknown> | undefined;
  const sender = data.sender as Record<string, unknown> | undefined;
  if (!message || !sender) return;

  const senderIdObj = sender.sender_id as Record<string, string> | undefined;
  const senderId = senderIdObj?.open_id ?? "";
  const chatId = (message.chat_id ?? "") as string;
  const msgType = (message.message_type ?? "text") as string;
  const messageId = (message.message_id ?? "") as string;
  const chatType = (message.chat_type ?? "") as string;

  if (!senderId || !chatId) return;

  const isGroupMessage = chatType === "group";
  const isAuthorizedGroup = isGroupMessage && hub.isAllowed(chatId);
  const isAuthorizedDirect = !isGroupMessage && hub.isAllowed(senderId);

  if (!isAuthorizedDirect && !isAuthorizedGroup) {
    const contentMeta: Record<string, unknown> = { content_type: msgType };
    if (messageId) contentMeta.message_id = messageId;
    if (chatType) contentMeta.chat_type = chatType;

    const evidence = recordUnauthorizedEvidence({
      channel: "feishu",
      ingestMode: "websocket",
      updateId: messageId || "",
      chatId,
      messageId: messageId || null,
      sourceUserId: senderId,
      contentType: msgType,
      contentMeta,
      rawJson: JSON.stringify(data),
      displayName: senderId,
      logError: (m) => hub.logError(m),
    });
    hub.recordSecurityEvent({
      sourceUserId: senderId,
      contentType: msgType,
      evidenceId: evidence?.evidence_id ?? "",
    });
    return;
  }

  const parsed = parseContentJson((message.content ?? "") as string);
  let content = (parsed.text ?? "") as string;

  // ── post 富文本（文字 + 附件组合） ────────────────────────────
  // 飞书 post 消息的 content 是富文本 JSON，形如：
  //   {"title":"","content":[[{"tag":"text","text":"..."},{"tag":"file","file_key":"...","file_name":"..."}]]}
  // parseContentJson 只取顶层 .text，post 没有顶层 text 字段 → 文件信息整个丢。
  // 这里从富文本数组里提取 text 拼接 + file 下载。
  if (msgType === "post" && messageId) {
    content = await extractFeishuPostParts(
      (message.content ?? "") as string,
      (fileKey, fileName) => downloadFeishuMedia(messageId, "file", fileKey, fileName),
    );
  } else if (msgType === "image" && messageId) {
    const imageKey = (parsed.image_key ?? "") as string;
    if (imageKey) {
      const filePath = await downloadFeishuMedia(messageId, "image", imageKey);
      content = filePath ? `[图片] ${filePath}` : `[图片: ${imageKey}]`;
    }
  } else if (msgType === "file" && messageId) {
    const fileKey = (parsed.file_key ?? "") as string;
    const fileName = (parsed.file_name ?? "file") as string;
    if (fileKey) {
      const filePath = await downloadFeishuMedia(messageId, "file", fileKey, fileName);
      content = filePath ? `[文件] ${filePath}` : content || `[文件: ${fileName}]`;
    }
  } else if (msgType === "audio" && messageId) {
    const fileKey = (parsed.file_key ?? "") as string;
    if (fileKey) {
      const filePath = await downloadFeishuMedia(messageId, "file", fileKey);
      if (filePath) {
        const text = await hub.resolveAsr(filePath);
        content = text ? `[语音] ${text}` : `[语音] ${filePath}`;
      } else {
        content = "[语音]";
      }
    } else {
      content = "[语音]";
    }
  }

  if (!content) return;

  const senderDisplay = hub.getNickname(senderId) || senderId;
  const displayName = isAuthorizedGroup
    ? `${senderDisplay} @ ${hub.getNickname(chatId)}`
    : senderDisplay;
  hub.log(`← ${displayName}: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`);

  const replyTo = isGroupMessage ? chatId : senderId;
  hub.pushMessage({
    channel: "feishu",
    from: displayName,
    fromId: replyTo,
    content,
    raw: {
      sender_id: senderId,
      chat_id: chatId,
      message_type: msgType,
      auth_sender_id: isAuthorizedGroup ? chatId : senderId,
    },
  });
}

// ── Fallback ────────────────────────────────────────────────────────────────

import { cliPlugin } from "./feishu-lark-cli.js";

let fallbackMode = false;

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: ChannelPlugin = {
  name: "feishu",
  displayName: "飞书",
  aliases: ["fs"],
  capabilities: ["text", "file", "image", "voice"],
  formatHints: "纯文本。飞书支持富文本卡片但当前通道走文本消息。语音以音频文件发送。",
  isNativeId(to) { return to.startsWith("ou_") || to.startsWith("oc_"); },

  async start(hubAPI) {
    hub = hubAPI;
    fallbackMode = false;

    const creds = loadFeishuConfig();
    if (!creds) {
      hub.log("SDK 凭证未配置，fallback 到 lark-cli 模式（推荐迁移到 SDK 直连，详见 feishu-README.md）");
      fallbackMode = true;
      return cliPlugin.start(hubAPI);
    }

    health = new ChannelHealth({
      name: "feishu",
      baseRetryMs: 5000,
      onRestart: async () => {
        hub.log("[feishu] 完整重启：断开 WebSocket → 重连");
        try { wsClient?.close?.(); } catch { /* best-effort */ }
        startConnection();
      },
      log: (msg) => hub.log(msg),
    });

    try {
      Lark = await import("@larksuiteoapi/node-sdk");
    } catch {
      hub.logError("@larksuiteoapi/node-sdk 未安装，fallback 到 lark-cli（请运行 bun install）");
      fallbackMode = true;
      return cliPlugin.start(hubAPI);
    }

    client = new Lark.Client({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: Lark.Domain.Feishu,
    });

    wsClient = new Lark.WSClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      domain: Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.error,
    });

    startConnection();
    hub.log("飞书通道已启动（SDK WebSocket 直连）");
  },

  async send(params): Promise<SendResult> {
    if (fallbackMode) {
      const result = await cliPlugin.send(params);
      if (cliPlugin.stoppedReason) plugin.stoppedReason = cliPlugin.stoppedReason;
      return result;
    }
    const { to, content, type, filePath } = params;
    if (!client) return { success: false, error: "飞书客户端未初始化" };

    try {
      const receiveIdType = to.startsWith("oc_") ? "chat_id" : "open_id";

      if (type === "text") {
        await client.im.v1.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: to,
            content: JSON.stringify({ text: content }),
            msg_type: "text",
          },
        });
        hub.log(`→ ${to.slice(0, 20)}...: ${content.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "file" && filePath) {
        const fileData = await fs.promises.readFile(filePath);
        const uploadResp = await client.im.v1.file.create({
          data: {
            file_type: "stream",
            file_name: filePath.split("/").pop() ?? "file",
            file: Buffer.from(fileData),
          },
        });
        if (!uploadResp?.file_key) return { success: false, error: "文件上传失败：未返回 file_key" };

        await client.im.v1.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: to,
            content: JSON.stringify({ file_key: uploadResp.file_key }),
            msg_type: "file",
          },
        });
        hub.log(`→ 文件: ${filePath.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "voice" && filePath) {
        const audioData = await fs.promises.readFile(filePath);
        const uploadResp = await client.im.v1.file.create({
          data: {
            file_type: "opus",
            file_name: filePath.split("/").pop() ?? "audio.ogg",
            file: Buffer.from(audioData),
          },
        });
        if (!uploadResp?.file_key) return { success: false, error: "语音上传失败：未返回 file_key" };

        await client.im.v1.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: to,
            content: JSON.stringify({ file_key: uploadResp.file_key }),
            msg_type: "audio",
          },
        });
        hub.log(`→ 语音: "${content.slice(0, 30)}..."`);
        return { success: true };
      }

      return { success: false, error: `不支持的类型: ${type}` };
    } catch (err) {
      const redacted = redactSensitive(String(err));
      if (type === "text" && isNetworkError(String(err))) {
        hub.logError(`发送失败（网络），${SEND_RETRY_DELAY_MS / 1000}s 后重试: ${redacted}`);
        await new Promise(r => setTimeout(r, SEND_RETRY_DELAY_MS));
        try {
          const receiveIdType = to.startsWith("oc_") ? "chat_id" : "open_id";
          await client!.im.v1.message.create({
            params: { receive_id_type: receiveIdType },
            data: { receive_id: to, content: JSON.stringify({ text: content }), msg_type: "text" },
          });
          return { success: true };
        } catch (retryErr) {
          const r2 = redactSensitive(String(retryErr));
          hub.logError(`重试也失败: ${r2}`);
          return { success: false, error: r2 };
        }
      }
      if (/token|auth|permission|403|401/i.test(String(err))) {
        plugin.stoppedReason = "auth";
      }
      hub.logError(`发送失败: ${redacted}`);
      return { success: false, error: redacted };
    }
  },

  async stop() {
    if (fallbackMode) return cliPlugin.stop();
    try { wsClient?.close?.(); } catch { /* best-effort */ }
    wsClient = null;
    client = null;
    readyReported = false;
    hub.log("飞书通道已停止");
  },
};

// ── Connection ──────────────────────────────────────────────────────────────

function startConnection(): void {
  if (!wsClient) return;

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        try {
          health.onSuccess();
          if (!readyReported) { hub.reportReady(); readyReported = true; }
          await handleMessage(data as unknown as Record<string, unknown>);
        } catch (err) {
          hub.logError(`handleMessage 异常: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        }
      },
    }),
  }).then(() => {
    hub.log("WebSocket 连接已建立");
    if (!readyReported) { hub.reportReady(); readyReported = true; }
  }).catch((err: unknown) => {
    hub.logError(`WebSocket 连接失败: ${String(err)}`);
    health.onFailure();
  });
}

export default plugin;
