/**
 * 飞书通道插件 — Forge Hub
 *
 * 基于 lark-cli（飞书官方 CLI）收发消息。
 * 收消息：lark-cli event consume（事件订阅，NDJSON 流）
 * 发消息：lark-cli im +messages-send
 */

import { ChannelStartSkipError } from "../types.js";
import type { ChannelPlugin, HubAPI, SendResult } from "../types.js";
import { STATE_DIR, redactSensitive } from "../config.js";
import { ChannelHealth } from "../channel-health.js";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { execFileText } from "../process-utils.js";
import { assertRealPathInsideDir, sanitizeMediaFileName } from "../media-path.js";
import { assertFileWithinMediaSizeLimit } from "../media-policy.js";
import { recordUnauthorizedEvidence } from "../evidence.js";
import { isNetworkError, SEND_RETRY_DELAY_MS } from "../send-retry.js";

// ── Constants ───────────────────────────────────────────────────────────────

// lark-cli 路径：优先 env `FORGE_LARK_CLI`，否则 which 动态找，否则 fallback 到 Apple-Silicon Homebrew 默认。
// Intel Mac 默认 `/usr/local/...`；Linux / npm -g 安装位置不同——用户自行设 env 覆盖。
function resolveLarkCli(): string {
  if (process.env.FORGE_LARK_CLI) return process.env.FORGE_LARK_CLI;
  try {
    const out = execFileSync("/usr/bin/which", ["lark-cli"], { encoding: "utf-8" }).trim();
    if (out) return out;
  } catch { /* command may not exist */ }
  return "/opt/homebrew/lib/node_modules/@larksuite/cli/bin/lark-cli"; // Apple-Silicon default
}
const LARK_CLI = resolveLarkCli();

// ── Module State ────────────────────────────────────────────────────────────

let hub: HubAPI;
let consumeProc: ReturnType<typeof spawn> | null = null;
let running = false;
let health: ChannelHealth;

// ── Stale Process Cleanup ──────────────────────────────────────────────────

const LARK_EVENT_PATTERN = "lark-cli event";

function pgrepLarkEvent(): string | null {
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-f", LARK_EVENT_PATTERN], { encoding: "utf-8" }).trim();
    return out || null;
  } catch { /* command may not exist */
    return null; // exit 1 = no match
  }
}

function pkillLarkEvent(signal?: string): void {
  try {
    const args = signal ? [signal, "-f", LARK_EVENT_PATTERN] : ["-f", LARK_EVENT_PATTERN];
    execFileSync("/usr/bin/pkill", args);
  } catch { /* command may not exist */ }
}

async function cleanupStaleLarkCli(): Promise<void> {
  const existing = pgrepLarkEvent();
  if (!existing) return;

  const pids = existing.split("\n").join(", ");
  hub.log(`检测到残留 lark-cli event 进程 (pid: ${pids})，正在清理...`);

  pkillLarkEvent();
  await new Promise(r => setTimeout(r, 2000));

  if (pgrepLarkEvent()) {
    hub.log(`残留进程未退出，强制终止 (SIGKILL)...`);
    pkillLarkEvent("-9");
    await new Promise(r => setTimeout(r, 1000));

    if (pgrepLarkEvent()) {
      hub.logError("残留 lark-cli 进程清理失败，飞书通道可能抢消息");
      return;
    }
  }

  hub.log("残留 lark-cli 进程已清理");
}

// ── Consume Health ─────────────────────────────────────────────────────────

let eventCount = 0;
let disconnectedAt = 0;

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

// ── Allowlist ───────────────────────────────────────────────────────────────

// ── Chat History ────────────────────────────────────────────────────────────

// History is now written by Hub layer (hub.ts onMessage/send)

// ── Media Download ──────────────────────────────────────────────────────────

const FEISHU_MEDIA_DIR = join(STATE_DIR, "feishu", "media");

async function downloadFeishuMedia(
  messageId: string,
  type: "image" | "file",
  fileKey: string,
  fileName?: string,
): Promise<string | null> {
  // 注意：lark-cli 的 --type 只支持 "image" | "file"，audio 也用 "file"（飞书把 audio 当普通附件发）

  if (!fileKey || !messageId) return null;
  let fullPath = "";
  try {
    await fs.promises.mkdir(FEISHU_MEDIA_DIR, { recursive: true });
    const outputName = sanitizeMediaFileName(fileName ?? `${type}.${type === "image" ? "png" : "dat"}`);
    // lark-cli only accepts relative paths
    await execFileText(LARK_CLI, [
      "im", "+messages-resources-download",
      "--message-id", messageId,
      "--file-key", fileKey,
      "--type", type,
      "--output", outputName,
      "--as", "bot",
    ], { timeout: 30000, cwd: FEISHU_MEDIA_DIR });
    fullPath = join(FEISHU_MEDIA_DIR, outputName);
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

// ── Event Consume ───────────────────────────────────────────────────────────

function startSubscription(): void {
  running = true;

  const proc = spawn(LARK_CLI, [
    "event", "consume",
    "im.message.receive_v1",
    "--as", "bot",
  ], {
    // stdin pipe: Hub 退出时管道断裂 → consume 检测 EOF → 自动退出
    stdio: ["pipe", "pipe", "pipe"],
  });

  consumeProc = proc;

  const rl = createInterface({ input: proc.stdout! });

  rl.on("line", (line: string) => {
    // 外层 isolation：readline 事件回调里的同步 throw 会冒到 process uncaughtException。
    // 任何异常（parse / handleMessage / hub.pushMessage）都不能让 Hub 整个崩。
    try {
      if (!line.trim()) return;

      health.onSuccess();
      disconnectedAt = 0;

      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch (err) {
        hub.logError(`事件解析失败: ${String(err)}`);
        return;
      }
      eventCount++;
      // fire-and-forget；ASR await 不 block readline 下一行；错误在 handleMessage 内 hub.logError
      void handleMessage(event as Record<string, unknown>).catch(err => {
        hub.logError(`handleMessage 异常: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      });
    } catch (err) {
      hub.logError(`事件处理异常（line 长度 ${line.length}）: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const msg = stripAnsi(data.toString().trim());
    if (!msg) return;

    if (msg.includes("Error") || msg.includes("disconnect") || msg.includes("connect failed")) {
      hub.logError(`[consume] ${msg}`);
      if (disconnectedAt === 0) disconnectedAt = Date.now();
    } else if (msg.includes("ready") || msg.includes("reconnect")) {
      hub.log(`[consume] ${msg}`);
      if (disconnectedAt > 0) {
        health.onSuccess();
        disconnectedAt = 0;
      }
    } else {
      hub.log(`[consume] ${msg}`);
    }
  });

  proc.on("close", (code: number | null) => {
    if (!running) return;
    if (disconnectedAt === 0) disconnectedAt = Date.now();
    hub.logError(`事件订阅进程退出 (code ${code})`);
    health.onFailure().then(delay => {
      if (!running) return;
      if (health.isDormant()) return;
      setTimeout(startSubscription, delay);
    });
  });

  proc.on("error", (err: Error) => {
    if (!running) return;
    if (disconnectedAt === 0) disconnectedAt = Date.now();
    hub.logError(`事件订阅启动失败: ${String(err)}`);
    health.onFailure().then(delay => {
      if (!running) return;
      if (health.isDormant()) return;
      setTimeout(startSubscription, delay);
    });
  });
}

async function handleMessage(event: Record<string, unknown>): Promise<void> {
  const senderId = (event.sender_id ?? "") as string;
  const chatId = (event.chat_id ?? "") as string;
  const msgType = (event.message_type ?? "text") as string;

  if (!senderId || !chatId) return;

  const chatType = (event.chat_type ?? "") as string;
  const isGroupMessage = chatType === "group";
  const isAuthorizedGroup = isGroupMessage && hub.isAllowed(chatId);
  const isAuthorizedDirect = !isGroupMessage && hub.isAllowed(senderId);
  if (!isAuthorizedDirect && !isAuthorizedGroup) {
    const messageId = (event.message_id ?? event.id ?? "") as string;
    const contentMeta: Record<string, unknown> = { content_type: msgType };
    if (messageId) contentMeta.message_id = messageId;
    if (chatType) contentMeta.chat_type = chatType;
    const fileKey = (event.file_key ?? "") as string;
    if (fileKey) contentMeta.file_key = fileKey;

    const evidence = recordUnauthorizedEvidence({
      channel: "feishu",
      ingestMode: "stdio",
      updateId: messageId || "",
      chatId,
      messageId: messageId || null,
      sourceUserId: senderId,
      contentType: msgType,
      contentMeta,
      rawJson: JSON.stringify(event),
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

  // Extract content + download media
  const messageId = (event.message_id ?? event.id ?? "") as string;
  let content = (event.content ?? "") as string;

  // image key 在 content 里: "[Image: img_v3_xxx]" 或 "[图片: img_v3_xxx]"
  const imageKeyMatch = content.match(/\[(?:Image|图片):\s*(img_[^\]]+)\]/);
  if (imageKeyMatch && messageId) {
    const imageKey = imageKeyMatch[1];
    const filePath = await downloadFeishuMedia(messageId, "image", imageKey);
    content = filePath ? `[图片] ${filePath}` : `[图片: ${imageKey}]`;
  } else if (msgType === "file" && messageId) {
    // file key 可能在 content 里: "[File: file_v3_xxx]"
    const fileKeyMatch = content.match(/\[(?:File|文件):\s*(file_[^\]]+)\]/);
    const fileKey = fileKeyMatch?.[1] ?? (event.file_key ?? "") as string;
    const fileName = (event.file_name ?? "file") as string;
    if (fileKey) {
      const filePath = await downloadFeishuMedia(messageId, "file", fileKey, fileName);
      content = filePath ? `[文件] ${filePath}` : content || `[文件: ${fileName}]`;
    }
  } else if (msgType === "audio") {
    // 飞书 audio event 里只给 file_key（无 ASR），和 image/file 一样要手动下载
    // file_key 可能在 content "[Audio: xxx]" 里，也可能在 event.file_key
    const audioKeyMatch = content.match(/\[Audio:\s*(\S+?)\]/);
    const fileKey = audioKeyMatch?.[1] ?? (event.file_key ?? "") as string;
    if (fileKey && messageId) {
      const filePath = await downloadFeishuMedia(messageId, "file", fileKey);
      if (filePath) {
        // Hub 层 ASR：走 FORGE_HUB_ASR_HOOK（用户 hook 可接 Whisper / MiniMax /
        // 或参考 examples/feishu-stream-asr.ts 接飞书原生 speech_to_text）
        // 没配 hook 就给 agent 一个 `[语音] ${path}` 占位
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

  // 群消息用 chat_id (oc_) 作为 fromId，这样 reply 会发到群里而不是私聊
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

  // History recorded by Hub layer
}

// ── Plugin ──────────────────────────────────────────────────────────────────

// 飞书入站 audio 走 Hub 层 ASR 链（plugin 不自带 asrTranscribe）——
// 用户想要飞书原生 speech_to_text API，见 examples/feishu-stream-asr.ts 参考实现，
// 在自己的 FORGE_HUB_ASR_HOOK 里按通道 dispatch 到那个脚本即可。
// Hub core 不绑飞书 ASR 细节是有意识的 trade-off：execFileSync 阻塞风险（详见
// example 顶部注释）+ 维护成本归属问题——做成 hook 让用户按需接入。
const plugin: ChannelPlugin = {
  name: "feishu",
  displayName: "飞书",
  aliases: ["fs"],
  capabilities: ["text", "file", "image", "voice"],
  formatHints: "纯文本。飞书支持富文本卡片但当前通道走文本消息。语音以音频文件发送。",
  // 飞书 user open_id: "ou_...", chat_id: "oc_..."
  isNativeId(to) { return to.startsWith("ou_") || to.startsWith("oc_"); },

  async start(hubAPI) {
    hub = hubAPI;

    health = new ChannelHealth({
      name: "feishu",
      baseRetryMs: 5000,
      onRestart: async () => {
        hub.log("[feishu] 完整重启：kill lark-cli → restart subscription");
        if (consumeProc) { consumeProc.kill(); consumeProc = null; }
        startSubscription();
      },
      log: (msg) => hub.log(msg),
    });

    // 清理残留的 lark-cli event 进程（Hub 异常退出 / SIGTERM 未走 stop() 时常见）。
    // 多进程订阅会抢消息（事件只投递给一个 client），必须确保只有一个。
    await cleanupStaleLarkCli();

    // Verify lark-cli is available and authenticated
    try {
      const result = execFileSync(LARK_CLI, ["auth", "status"], { encoding: "utf-8", timeout: 10000 });
      if (result.includes("not logged in") || result.includes("not configured")) {
        hub.logError("lark-cli 未认证。请运行: lark-cli auth login --domain im,event");
        throw new ChannelStartSkipError("lark-cli 未认证");
      }
      hub.log("lark-cli 认证有效");
    } catch (err) {
      if (err instanceof ChannelStartSkipError) throw err;
      hub.logError(`lark-cli 不可用: ${String(err)}`);
      throw new ChannelStartSkipError("lark-cli 不可用或未正确安装");
    }

    // Start event subscription
    startSubscription();
    hub.log("飞书通道已启动");
  },

  async send({ to, content, type, filePath }): Promise<SendResult> {
    try {
      // P2P 单聊: to 是 ou_（用户 ID）→ --user-id；群聊: to 是 oc_（会话 ID）→ --chat-id
      const idFlag = to.startsWith("oc_") ? "--chat-id" : "--user-id";

      if (type === "text") {
        await execFileText(LARK_CLI, [
          "im", "+messages-send",
          idFlag, to,
          "--text", content,
          "--as", "bot",
        ], { timeout: 15000 });

        hub.log(`→ ${to.slice(0, 20)}...: ${content.slice(0, 60)}`);
        // History recorded by Hub layer
        return { success: true };
      }

      if (type === "file" && filePath) {
        await execFileText(LARK_CLI, [
          "im", "+messages-send",
          idFlag, to,
          "--file", filePath,
          "--as", "bot",
        ], { timeout: 30000 });

        hub.log(`→ 文件: ${filePath.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "voice" && filePath) {
        // 飞书 audio 消息必须用 `--audio` flag（不是 --file）——否则飞书返
        // 230055: "file type does not match message type"。
        // lark-cli 的 --audio 接 basename，实际文件要在 cwd 里找。
        await execFileText(LARK_CLI, [
          "im", "+messages-send",
          idFlag, to,
          "--audio", basename(filePath),
          "--as", "bot",
        ], { timeout: 30000, cwd: dirname(filePath) });

        hub.log(`→ 语音: "${content.slice(0, 30)}..."`);
        return { success: true };
      }

      return { success: false, error: `不支持的类型: ${type}` };
    } catch (err) {
      const redacted = redactSensitive(String(err));
      if (type === "text" && isNetworkError(String(err))) {
        hub.logError(`发送失败（网络），${SEND_RETRY_DELAY_MS}ms 后重试: ${redacted}`);
        await new Promise(r => setTimeout(r, SEND_RETRY_DELAY_MS));
        try {
          const idFlag = to.startsWith("oc_") ? "--chat-id" : "--user-id";
          await execFileText(LARK_CLI, ["im", "+messages-send", idFlag, to, "--text", content, "--as", "bot"], { timeout: 15000 });
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
    running = false;
    const proc = consumeProc;
    consumeProc = null;
    if (proc) {
      proc.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 3000);
        proc.once("close", () => { clearTimeout(timer); resolve(); });
        proc.kill("SIGTERM");
      });
      pkillLarkEvent();
    }
    hub.log("飞书事件订阅已停止");
  },
};

export default plugin;
