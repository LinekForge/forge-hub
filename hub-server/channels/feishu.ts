/**
 * 飞书通道插件 — Forge Hub
 *
 * 基于 lark-cli（飞书官方 CLI）收发消息。
 * 收消息：lark-cli event +subscribe（WebSocket 事件订阅，NDJSON 流）
 * 发消息：lark-cli im +messages-send
 */

import { ChannelStartSkipError } from "../types.js";
import type { ChannelPlugin, HubAPI, SendResult } from "../types.js";
import { redactSensitive } from "../config.js";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

// ── Constants ───────────────────────────────────────────────────────────────

// lark-cli 路径：优先 env `FORGE_LARK_CLI`，否则 which 动态找，否则 fallback 到 Apple-Silicon Homebrew 默认。
// Intel Mac 默认 `/usr/local/...`；Linux / npm -g 安装位置不同——用户自行设 env 覆盖。
function resolveLarkCli(): string {
  if (process.env.FORGE_LARK_CLI) return process.env.FORGE_LARK_CLI;
  try {
    const out = execFileSync("/usr/bin/which", ["lark-cli"], { encoding: "utf-8" }).trim();
    if (out) return out;
  } catch {}
  return "/opt/homebrew/lib/node_modules/@larksuite/cli/bin/lark-cli"; // Apple-Silicon default
}
const LARK_CLI = resolveLarkCli();

// ── Module State ────────────────────────────────────────────────────────────

let hub: HubAPI;
let subscribeProc: ReturnType<typeof spawn> | null = null;
let running = false;

// ── Subscription Health ────────────────────────────────────────────────────

let restartCount = 0;
let restartDelay = 5000;
let eventCount = 0;
let disconnectedAt = 0;
const MAX_RESTART_DELAY = 60000;
// lark-cli event +subscribe 一直挂 → 达到上限停止该通道。
// 选 200：以 max 60s 间隔 ≈ 3h+ 连续失败。用户这个时间一定会发现。避免无限空转。
const MAX_RESTART_COUNT = 200;

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
}

// ── Allowlist ───────────────────────────────────────────────────────────────

import type { Allowlist } from "../types.js";  // 统一 schema，详见 types.ts::Allowlist

function getAllowlist(): Allowlist {
  return (hub.getState("allowlist") ?? { allowed: [], auto_allow_next: false }) as Allowlist;
}

function isAllowed(userId: string): boolean {
  return getAllowlist().allowed.some((e) => e.id === userId);
}

function getNickname(userId: string): string {
  const entry = getAllowlist().allowed.find((e) => e.id === userId);
  return entry?.nickname ?? userId;
}

// ── Chat History ────────────────────────────────────────────────────────────

// History is now written by Hub layer (hub.ts onMessage/send)

// ── Media Download ──────────────────────────────────────────────────────────

const FEISHU_MEDIA_DIR = join(homedir(), ".forge-hub", "state", "feishu", "media");

function downloadFeishuMedia(messageId: string, type: "image" | "file", fileKey: string, fileName?: string): string | null {
  // 注意：lark-cli 的 --type 只支持 "image" | "file"，audio 也用 "file"（飞书把 audio 当普通附件发）

  if (!fileKey || !messageId) return null;
  try {
    mkdirSync(FEISHU_MEDIA_DIR, { recursive: true });
    const outputName = fileName ?? `${type}_${Date.now()}.${type === "image" ? "png" : "dat"}`;
    // lark-cli only accepts relative paths
    execFileSync(LARK_CLI, [
      "im", "+messages-resources-download",
      "--message-id", messageId,
      "--file-key", fileKey,
      "--type", type,
      "--output", outputName,
      "--as", "bot",
    ], { encoding: "utf-8", timeout: 30000, cwd: FEISHU_MEDIA_DIR });
    const fullPath = join(FEISHU_MEDIA_DIR, outputName);
    hub.log(`📎 下载: ${outputName}`);
    return fullPath;
  } catch (err) {
    hub.logError(`媒体下载失败: ${String(err)}`);
    return null;
  }
}

// ── Event Subscription ──────────────────────────────────────────────────────

function startSubscription(): void {
  running = true;

  const proc = spawn(LARK_CLI, [
    "event", "+subscribe",
    "--compact",
    "--as", "bot",
    "--force",
    "--filter", "^im\\.message",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  subscribeProc = proc;

  const rl = createInterface({ input: proc.stdout! });

  rl.on("line", (line: string) => {
    // 外层 isolation：readline 事件回调里的同步 throw 会冒到 process uncaughtException。
    // 任何异常（parse / handleMessage / hub.pushMessage）都不能让 Hub 整个崩。
    try {
      if (!line.trim()) return;

      // First successful event → reset restart state
      if (restartCount > 0 && disconnectedAt > 0) {
        const downtime = Math.round((Date.now() - disconnectedAt) / 1000);
        hub.log(`✅ 事件订阅恢复（断连 ${downtime}s，重启 ${restartCount} 次）`);
        restartCount = 0;
        restartDelay = 5000;
        disconnectedAt = 0;
      }

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

    // Classify stderr output
    if (msg.includes("SDK Error") || msg.includes("disconnect") || msg.includes("connect failed")) {
      hub.logError(`[subscribe] ${msg}`);
    } else if (msg.includes("Connected") || msg.includes("reconnect")) {
      hub.log(`[subscribe] ${msg}`);
      // lark-cli internal reconnect succeeded
      if (msg.includes("Connected") && disconnectedAt > 0) {
        const downtime = Math.round((Date.now() - disconnectedAt) / 1000);
        hub.log(`✅ lark-cli 内部重连成功（断连 ${downtime}s）`);
        disconnectedAt = 0;
        restartCount = 0;
        restartDelay = 5000;
      }
    } else {
      hub.log(`[subscribe] ${msg}`);
    }

    // Track disconnect start
    if ((msg.includes("disconnect") || msg.includes("SDK Error")) && disconnectedAt === 0) {
      disconnectedAt = Date.now();
    }
  });

  proc.on("close", (code: number | null) => {
    if (!running) return;
    restartCount++;
    if (disconnectedAt === 0) disconnectedAt = Date.now();
    if (restartCount > MAX_RESTART_COUNT) {
      hub.logError(`💀 飞书事件订阅重启达 ${MAX_RESTART_COUNT} 次上限，停止该通道（lark-cli 可能异常）`);
      plugin.stoppedReason = "cap_reached";
      running = false;
      return;
    }
    hub.logError(`事件订阅进程退出 (code ${code}) · 重启 #${restartCount}，${restartDelay / 1000}s 后重连`);
    setTimeout(startSubscription, restartDelay);
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY);
  });

  proc.on("error", (err: Error) => {
    if (!running) return;
    restartCount++;
    if (disconnectedAt === 0) disconnectedAt = Date.now();
    if (restartCount > MAX_RESTART_COUNT) {
      hub.logError(`💀 飞书事件订阅重启达 ${MAX_RESTART_COUNT} 次上限，停止该通道`);
      plugin.stoppedReason = "cap_reached";
      running = false;
      return;
    }
    hub.logError(`事件订阅启动失败 #${restartCount}: ${String(err)} · ${restartDelay / 1000}s 后重试`);
    setTimeout(startSubscription, restartDelay);
    restartDelay = Math.min(restartDelay * 2, MAX_RESTART_DELAY);
  });
}

async function handleMessage(event: Record<string, unknown>): Promise<void> {
  // Compact format: type (not event_type), content is plain text
  const eventType = (event.type ?? "") as string;
  if (!eventType.includes("im.message")) {
    // Graceful ignore: 非消息事件（如 bot_p2p_chat_entered_v1）不计入失败
    if (eventType) hub.log(`[飞书] 忽略非消息事件: ${eventType}`);
    return;
  }

  const senderId = (event.sender_id ?? "") as string;
  const chatId = (event.chat_id ?? "") as string;
  const msgType = (event.message_type ?? "text") as string;
  const senderName = (event.sender_name ?? senderId) as string;

  if (!senderId || !chatId) return;

  // Check allowlist — 非主人拒收 + push system 告警（统一 4 通道模式）
  // 群消息：群 chat_id (oc_) 在白名单即视为授权（群成员无需单独加白名单）
  const isGroupMessage = chatId.startsWith("oc_");
  if (!isAllowed(senderId) && !(isGroupMessage && isAllowed(chatId))) {
    const rawPreview = (event.content ?? "") as string;
    hub.logError(`⛔ 拒绝未授权: ${senderName} (${senderId}), 原文前 50: "${rawPreview.slice(0, 50)}"`);
    hub.pushMessage({
      channel: "feishu",
      from: "system",
      fromId: "system",
      content: hub.formatUnauthorizedNotice(senderName, senderId, rawPreview),
      raw: {},
    });
    return;
  }

  // Extract content + download media
  const messageId = (event.message_id ?? event.id ?? "") as string;
  let content = (event.content ?? "") as string;

  // Compact mode: image key is in content as "[Image: img_v3_xxx]" or "[图片: img_v3_xxx]"
  const imageKeyMatch = content.match(/\[(?:Image|图片):\s*(img_[^\]]+)\]/);
  if (imageKeyMatch && messageId) {
    const imageKey = imageKeyMatch[1];
    const filePath = downloadFeishuMedia(messageId, "image", imageKey);
    content = filePath ? `[图片] ${filePath}` : `[图片: ${imageKey}]`;
  } else if (msgType === "file" && messageId) {
    // Compact mode: file key might be in content as "[File: file_v3_xxx]"
    const fileKeyMatch = content.match(/\[(?:File|文件):\s*(file_[^\]]+)\]/);
    const fileKey = fileKeyMatch?.[1] ?? (event.file_key ?? "") as string;
    const fileName = (event.file_name ?? "file") as string;
    if (fileKey) {
      const filePath = downloadFeishuMedia(messageId, "file", fileKey, fileName);
      content = filePath ? `[文件] ${filePath}` : content || `[文件: ${fileName}]`;
    }
  } else if (msgType === "audio") {
    // 飞书 audio event 里只给 file_key（无 ASR），和 image/file 一样要手动下载
    // compact mode 下 file_key 可能在 content "[Audio: xxx]" 里也可能在 event.file_key
    const audioKeyMatch = content.match(/\[Audio:\s*(\S+?)\]/);
    const fileKey = audioKeyMatch?.[1] ?? (event.file_key ?? "") as string;
    if (fileKey && messageId) {
      const filePath = downloadFeishuMedia(messageId, "file", fileKey);
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

  const displayName = getNickname(senderId) || senderName;
  hub.log(`← ${displayName}: ${content.slice(0, 80)}${content.length > 80 ? "..." : ""}`);

  // 群消息用 chat_id (oc_) 作为 fromId，这样 reply 会发到群里而不是私聊
  const replyTo = chatId.startsWith("oc_") ? chatId : senderId;
  hub.pushMessage({
    channel: "feishu",
    from: displayName,
    fromId: replyTo,
    content,
    raw: { sender_id: senderId, chat_id: chatId, message_type: msgType },
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
  // 飞书 user open_id: "ou_...", chat_id: "oc_..."
  isNativeId(to) { return to.startsWith("ou_") || to.startsWith("oc_"); },

  async start(hubAPI) {
    hub = hubAPI;

    // S2: detect stale lark-cli event subscribers before starting our own.
    // 飞书 app 只允许一个 WebSocket listener——多进程同时订阅会抢消息（事件
    // 只投递一次，先拿到的进程消费掉）。常见触发：用户的 wrapper 脚本自己
    // spawn lark-cli、之前手动 debug 留下的进程、或 forge-hub 前一次异常退出
    // 未走 stop() 的残留。不自动 kill（可能是用户有意在跑），log 告诉用户
    // 怎么清 + 本次启动跳过。watchdog 不会自动重启（stoppedReason="config"）。
    try {
      const existing = execFileSync("/usr/bin/pgrep", [
        "-f", "lark-cli event \\+subscribe",
      ], { encoding: "utf-8" }).trim();
      if (existing) {
        const pids = existing.split("\n").join(", ");
        hub.logError(
          `⚠️ 已有 lark-cli event +subscribe 进程在跑 (pid: ${pids})。` +
          `飞书 app 只允许一个 WebSocket listener——多进程会抢消息。` +
          `请先 \`pkill -f 'lark-cli event'\` 清理（或检查是否有其他 wrapper / 调试进程残留），然后重启 hub。本次飞书通道启动跳过。`,
        );
        plugin.stoppedReason = "config";
        throw new ChannelStartSkipError("已有其他 lark-cli subscriber 正在占用飞书事件流");
      }
    } catch (err) {
      if (err instanceof ChannelStartSkipError) throw err;
      // pgrep exit 1 = no match = safe to continue
    }

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
        execFileSync(LARK_CLI, [
          "im", "+messages-send",
          idFlag, to,
          "--text", content,
          "--as", "bot",
        ], { encoding: "utf-8", timeout: 15000 });

        hub.log(`→ ${to.slice(0, 20)}...: ${content.slice(0, 60)}`);
        // History recorded by Hub layer
        return { success: true };
      }

      if (type === "file" && filePath) {
        execFileSync(LARK_CLI, [
          "im", "+messages-send",
          idFlag, to,
          "--file", filePath,
          "--as", "bot",
        ], { encoding: "utf-8", timeout: 30000 });

        hub.log(`→ 文件: ${filePath.slice(0, 60)}`);
        return { success: true };
      }

      if (type === "voice" && filePath) {
        // 飞书 audio 消息必须用 `--audio` flag（不是 --file）——否则飞书返
        // 230055: "file type does not match message type"。
        // lark-cli 的 --audio 接 basename，实际文件要在 cwd 里找。
        execFileSync(LARK_CLI, [
          "im", "+messages-send",
          idFlag, to,
          "--audio", basename(filePath),
          "--as", "bot",
        ], { encoding: "utf-8", timeout: 30000, cwd: dirname(filePath) });

        hub.log(`→ 语音: "${content.slice(0, 30)}..."`);
        return { success: true };
      }

      return { success: false, error: `不支持的类型: ${type}` };
    } catch (err) {
      const redacted = redactSensitive(String(err));
      hub.logError(`发送失败: ${redacted}`);
      return { success: false, error: redacted };
    }
  },

  async stop() {
    running = false;
    if (subscribeProc) {
      subscribeProc.kill("SIGTERM");
      hub.log("飞书事件订阅已停止");
    }
  },
};

export default plugin;
