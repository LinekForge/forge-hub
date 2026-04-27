#!/usr/bin/env bun
/**
 * Forge Hub Client — 通用 MCP channel
 *
 * 连接 Hub 的 SSE 端点，接收所有通道的消息，注入 Claude 上下文。
 * 一个 channel 搞定所有通道。
 */

if (!process.env.NO_PROXY) process.env.NO_PROXY = "127.0.0.1,localhost";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// 使用 zod/v4-mini 而非默认入口（= v4 classic）——MCP SDK 内部用 z4mini.safeParse 解析
// notification schema，保持同一 flavor 能消除 cross-flavor parse 的潜在风险。
import { z } from "zod/v4-mini";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  getSessionConfigPaths,
  isChannelMode,
  readAndClearSessionConfig,
  type SessionConfig,
} from "./session-config.js";

// ── Config ──────────────────────────────────────────────────────────────────

const HUB_URL = process.env.FORGE_HUB_URL ?? "http://localhost:9900";
// HUB_DIR：和 hub-server 的 config.ts 保持一致，都读 FORGE_HUB_DIR env
const HUB_DIR = process.env.FORGE_HUB_DIR ?? path.join(process.env.HOME ?? "~", ".forge-hub");

// Token source: env var first (for test / override), then $HUB_DIR/api-token
// file (chmod 600). File is the canonical store so plist-set tokens reach
// MCP subprocess even when Claude Code didn't inherit the plist env.
function readAuthToken(): string {
  const fromEnv = process.env.HUB_API_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const tokenFile = path.join(HUB_DIR, "api-token");
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, "utf-8").trim();
    }
  } catch { /* ignore */ }
  return "";
}

const HUB_API_TOKEN = readAuthToken();
const BUN_BINARY = process.execPath && process.execPath.includes("bun")
  ? process.execPath
  : "bun";

function authHeaders(): Record<string, string> {
  return HUB_API_TOKEN ? { "Authorization": `Bearer ${HUB_API_TOKEN}` } : {};
}

// Use Claude CC pid (stable across process lifetime, same for CLI sibling process).
// We previously read ~/.claude/sessions/<ppid>.json for sessionId[0:8], but:
// (a) race — file doesn't exist at module-load time; hub-client + CLI compute different IDs
// (b) CC sometimes writes a stale sessionId; menubar has a separate repair flow for that
// ppid is what both hub-client and CLI's Bash spawn share: parent = Claude CC process.
function getInstanceId(): string {
  return `forge-${process.ppid ?? "default"}`;
}
const INSTANCE_ID = getInstanceId();

// ── Session Config ─────────────────────────────────────────────────────────

const { identitiesFile: IDENTITIES_FILE } = getSessionConfigPaths(HUB_DIR);

// ── File log 辅助 ──────────────────────────────────────────────────────────
// Claude Code 把 MCP subprocess 的 stderr 直接丢弃——没有 persistent debug file。
// 我们自己写 ~/.forge-hub/hub-client.log（每 instance 一行 append，带 INSTANCE_ID + timestamp）——
// 方便事后 debug 类似"Hub 推了 252 条但 client 没注入"这种没有证据的事故。
const CLIENT_LOG_FILE = path.join(HUB_DIR, "hub-client.log");
const HUB_STATUS_TIMEOUT_MS = 2_000;
const HUB_RECOVERY_POLL_MS = 1_000;
const WS_RETRY_START_MS = 1_000;
const WS_RETRY_MAX_MS = 30_000;
const CHANNEL_HANDLER_READY_TIMEOUT_MS = 60_000;
const CHANNEL_HANDLER_READY_POLL_MS = 250;
const CHANNEL_READY_LOGS = new Set([
  "Channel notifications registered",
  "Channel notifications re-registered after reconnect",
]);
const PROCESS_STARTED_AT = new Date();

function writeFileLog(level: "INFO" | "ERROR", msg: string): void {
  try {
    const line = `[${new Date().toISOString()}] [${INSTANCE_ID}] ${level} ${msg}\n`;
    fs.appendFileSync(CLIENT_LOG_FILE, line, "utf-8");
  } catch {
    // 无法写 file log——stderr 兜底，不崩
  }
}

function log(msg: string) {
  process.stderr.write(`[hub-client] ${msg}\n`);
  writeFileLog("INFO", msg);
}

function logError(msg: string) {
  process.stderr.write(`[hub-client] ERROR: ${msg}\n`);
  writeFileLog("ERROR", msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeHubStatus(timeoutMs = HUB_STATUS_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${HUB_URL}/status`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const SESSION_CONFIG = readAndClearSessionConfig(getSessionConfigPaths(HUB_DIR), INSTANCE_ID, logError);

// ── Claude Code Channel Handler Readiness ─────────────────────────────────

let channelHandlerReady = false;

function djb2Hash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

function sanitizeMcpLogPathPart(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;
  return `${sanitized.slice(0, 200)}-${Math.abs(djb2Hash(name)).toString(36)}`;
}

function getClaudeMcpLogDirs(serverName: string, cwd: string): string[] {
  if (process.platform !== "darwin") return [];
  const home = process.env.HOME;
  if (!home) return [];

  const base = path.join(home, "Library", "Caches", "claude-cli-nodejs");
  const projectDir = sanitizeMcpLogPathPart(cwd);
  const logDir = `mcp-logs-${sanitizeMcpLogPathPart(serverName)}`;
  const dirs = [path.join(base, projectDir, logDir)];

  // Historical notes disagreed on whether the leading "-" is kept. Claude Code
  // keeps it, but trying both paths makes this diagnostic dependency tolerant.
  const withoutLeadingDash = projectDir.replace(/^-+/, "");
  if (withoutLeadingDash && withoutLeadingDash !== projectDir) {
    dirs.push(path.join(base, withoutLeadingDash, logDir));
  }

  return dirs;
}

function listClaudeMcpLogFiles(serverName: string): string[] {
  const files: string[] = [];
  for (const dir of getClaudeMcpLogDirs(serverName, process.cwd())) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith(".jsonl")) files.push(path.join(dir, entry));
      }
    } catch {
      // Directory may not exist yet; wait loop will retry.
    }
  }
  return files.sort();
}

function fileMentionsThisInstance(file: string): boolean {
  try {
    return fs.readFileSync(file, "utf-8").includes(INSTANCE_ID);
  } catch {
    return false;
  }
}

function selectMcpLogFilesForThisProcess(files: string[]): string[] {
  const withInstance = files.filter(fileMentionsThisInstance);
  if (withInstance.length > 0) return withInstance.slice(-3);
  return files.slice(-3);
}

function hasChannelHandlerReadyLogSince(since: Date): boolean {
  const files = selectMcpLogFilesForThisProcess(listClaudeMcpLogFiles("hub"));
  const sinceMs = since.getTime();

  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      if (
        !line.includes("Channel notifications registered") &&
        !line.includes("Channel notifications re-registered after reconnect")
      ) {
        continue;
      }

      try {
        const event = JSON.parse(line) as { debug?: unknown; timestamp?: unknown; cwd?: unknown };
        if (typeof event.debug !== "string" || !CHANNEL_READY_LOGS.has(event.debug)) continue;
        if (typeof event.cwd === "string" && event.cwd !== process.cwd()) continue;
        if (typeof event.timestamp !== "string") continue;
        const timestamp = Date.parse(event.timestamp);
        if (!Number.isFinite(timestamp) || timestamp < sinceMs) continue;
        return true;
      } catch {
        // Tailing JSONL can see a partial line; ignore and retry.
      }
    }
  }

  return false;
}

async function waitForChannelHandlerReady(timeoutMs = CHANNEL_HANDLER_READY_TIMEOUT_MS): Promise<boolean> {
  if (channelHandlerReady) return true;
  if (process.platform !== "darwin") {
    channelHandlerReady = true;
    log("非 macOS 平台跳过 Claude Code MCP log readiness gate");
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  const dirs = getClaudeMcpLogDirs("hub", process.cwd());
  log("WebSocket 已连接，等待 Claude Code channel handler 注册...");

  while (Date.now() < deadline) {
    if (hasChannelHandlerReadyLogSince(PROCESS_STARTED_AT)) {
      channelHandlerReady = true;
      await sleep(0);
      log("Claude Code channel handler 已注册");
      return true;
    }
    await sleep(CHANNEL_HANDLER_READY_POLL_MS);
  }

  logError(
    `等待 Claude Code channel handler 注册超时 (${timeoutMs / 1000}s)，` +
      `不发送 ready，避免历史被丢弃。MCP log dirs: ${dirs.join(", ") || "<unavailable>"}`,
  );
  return false;
}

// ── Hub Auto-Start ──────────────────────────────────────────────────────────

async function ensureHubRunning(): Promise<boolean> {
  if (await probeHubStatus()) {
    return true;
  }

  // Hub not running, try to start it
  log("Hub 未运行，尝试自动启动...");
  try {
    const hubPath = path.join(HUB_DIR, "hub.ts");
    const child = spawn(BUN_BINARY, [hubPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Wait for Hub to start
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (await probeHubStatus()) {
        log("Hub 自动启动成功");
        return true;
      }
    }

    logError("Hub 启动超时（10s）");
    return false;
  } catch (err) {
    logError(`Hub 启动失败: ${String(err)}`);
    return false;
  }
}

// ── WebSocket Connection ────────────────────────────────────────────────────

let mcpServer: Server;

const WS_URL = HUB_URL.replace(/^http/, "ws");

// ── Notification Health ────────────────────────────────────────────────────

let notificationFailCount = 0;
const MAX_NOTIFICATION_FAILS = 5;
const NOTIFY_RETRY_ATTEMPTS = 3;
const NOTIFY_RETRY_DELAY = 1000;

async function safeNotify(params: { content: string; meta: Record<string, string> }): Promise<boolean> {
  for (let attempt = 0; attempt < NOTIFY_RETRY_ATTEMPTS; attempt++) {
    try {
      await mcpServer.notification({
        method: "notifications/claude/channel",
        params: { content: params.content, meta: params.meta },
      });
      notificationFailCount = 0;
      return true;
    } catch (err) {
      if (attempt < NOTIFY_RETRY_ATTEMPTS - 1) {
        log(`notification 重试 ${attempt + 1}/${NOTIFY_RETRY_ATTEMPTS}...`);
        await new Promise((r) => setTimeout(r, NOTIFY_RETRY_DELAY));
        continue;
      }
      notificationFailCount++;
      logError(`notification 失败 (${notificationFailCount}/${MAX_NOTIFICATION_FAILS}): ${String(err)}`);
      if (notificationFailCount >= MAX_NOTIFICATION_FAILS) {
        logError("notification 连续失败，MCP 连接可能已断。退出进程让 CC 重启。");
        process.exit(1);
      }
      return false;
    }
  }
  return false;
}

// ── Message Handler ────────────────────────────────────────────────────────

async function handleMessage(msg: Record<string, unknown>): Promise<void> {
  switch (msg.type) {
    case "connected":
      log("WebSocket 连接已确认");
      break;

    case "history": {
      const ch = msg.channel as string;
      const entries = msg.entries as { ts: string; direction: string; from: string; text: string }[];
      if (!entries?.length) break;
      const lines = entries.map((h) => {
        const time = new Date(h.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        const arrow = h.direction === "in" ? "←" : "→";
        return `${time} ${arrow} ${h.from}: ${h.text}`;
      });
      await safeNotify({
        content: `【${ch} 历史记录】以下是近期对话，仅用于恢复上下文。\n${lines.join("\n")}\n【历史记录结束】`,
        meta: { sender: "system", sender_id: "system", hub_channel: "system" },
      });
      log(`📜 回放 ${entries.length} 条 ${ch} 历史`);
      break;
    }

    case "context": {
      const peers = msg.peers as number;
      const rawChannels = msg.channels as ({ id: string; name: string } | string)[];
      const channels = rawChannels?.map(ch => typeof ch === "string" ? ch : ch.name).join("、") || "无";
      await safeNotify({
        content: `当前有 ${peers} 个窗口在线。可用通道：${channels}。`,
        meta: { sender: "system", sender_id: "system", hub_channel: "system" },
      });
      break;
    }

    case "system":
    case "message":
    case "instance_message": {
      await safeNotify({
        content: msg.content as string,
        meta: {
          sender: msg.from as string,
          sender_id: msg.fromId as string,
          hub_channel: msg.channel as string,
        },
      });
      break;
    }

    case "permission_response": {
      // 审批链路的"最后一公里"——这一步失败 Claude Code 会卡死等超时，
      // 必须把解析失败和转发失败分开 logError，让定位方向明确。

      let payload: { request_id: string; behavior: "allow" | "deny" };
      try {
        const parsed = JSON.parse(msg.content as string) as unknown;
        if (
          typeof parsed !== "object" || parsed === null ||
          typeof (parsed as { request_id?: unknown }).request_id !== "string" ||
          ((parsed as { behavior?: unknown }).behavior !== "allow" &&
            (parsed as { behavior?: unknown }).behavior !== "deny")
        ) {
          throw new Error(`invalid payload shape: ${String(msg.content).slice(0, 200)}`);
        }
        payload = parsed as { request_id: string; behavior: "allow" | "deny" };
      } catch (err) {
        logError(`permission_response 解析失败: ${String(err)}`);
        break;
      }

      try {
        await mcpServer.notification({
          method: "notifications/claude/channel/permission",
          params: {
            request_id: payload.request_id,
            behavior: payload.behavior,
          },
        });
        log(`🔓 审批响应 ${payload.request_id} → ${payload.behavior} 已回传 Claude Code`);
      } catch (err) {
        logError(
          `permission_response MCP notification 转发失败 ` +
            `(req=${payload.request_id}, behavior=${payload.behavior}): ${String(err)}`,
        );
      }
      break;
    }
  }
}

// ── WebSocket Connect ──────────────────────────────────────────────────────

async function connectWebSocket(): Promise<void> {
  // Token via query param (WebSocket spec doesn't allow custom headers in browsers).
  // 127.0.0.1 default bind + no proxy → no log-leak surface.
  const tokenQuery = HUB_API_TOKEN ? `&token=${encodeURIComponent(HUB_API_TOKEN)}` : "";
  const url = `${WS_URL}/ws?instance=${INSTANCE_ID}${tokenQuery}`;
  // Redact token in log output — never print the query param verbatim.
  log(`WebSocket 连接: ${WS_URL}/ws?instance=${INSTANCE_ID}${HUB_API_TOKEN ? " (authenticated)" : ""}`);

  return new Promise<void>((_, reject) => {
    const ws = new WebSocket(url);
    let mcpReady = false;

    ws.onopen = async () => {
      const ready = await waitForChannelHandlerReady();
      if (!ready) {
        ws.close(1013, "Claude Code channel handler not ready");
        return;
      }
      mcpReady = true;

      // Build ready message from session config
      const readyMsg: Record<string, unknown> = { type: "ready" };
      if (SESSION_CONFIG) {
        if (SESSION_CONFIG.tag) readyMsg.tag = SESSION_CONFIG.tag;
        if (SESSION_CONFIG.description) readyMsg.description = SESSION_CONFIG.description;
        if (SESSION_CONFIG.channels) readyMsg.channels = SESSION_CONFIG.channels;
        if (SESSION_CONFIG.history) readyMsg.history = SESSION_CONFIG.history;
      }

      ws.send(JSON.stringify(readyMsg));
      log("📡 已发送 ready，等待历史+上下文");
    };

    const messageQueue: string[] = [];

    ws.onmessage = async (event) => {
      if (!mcpReady) {
        // Buffer messages until MCP is ready (don't discard)
        messageQueue.push(event.data as string);
        return;
      }
      // Flush any queued messages first
      while (messageQueue.length > 0) {
        try {
          const queued = JSON.parse(messageQueue.shift()!);
          await handleMessage(queued);
        } catch (err) {
          logError(`队列消息处理失败: ${String(err)}`);
        }
      }
      try {
        const msg = JSON.parse(event.data as string);
        await handleMessage(msg);
      } catch (err) {
        logError(`WebSocket 消息处理失败: ${String(err)}`);
      }
    };

    ws.onclose = (event) => {
      reject(new Error(`WebSocket 关闭 (code=${event.code})`));
    };

    ws.onerror = () => {
      logError("WebSocket 连接错误");
    };
  });
}

// ── Auto-Reconnect ──────────────────────────────────────────────────────────

async function connectWithRetry(): Promise<void> {
  let retryDelay = WS_RETRY_START_MS;
  let connectCount = 0;

  while (true) {
    if (!await probeHubStatus()) {
      const started = await ensureHubRunning();
      if (!started) {
        log("Hub 不可达，开始轮询 /status 等待恢复...");
      }
      while (!await probeHubStatus()) {
        await sleep(HUB_RECOVERY_POLL_MS);
      }
      retryDelay = WS_RETRY_START_MS;
      log("Hub 已恢复，立即重连 WebSocket...");
    }

    try {
      connectCount++;
      log(`WebSocket 连接尝试 #${connectCount}...`);
      await connectWebSocket();
      retryDelay = WS_RETRY_START_MS;
    } catch (err) {
      const reason = String(err);
      if (!await probeHubStatus()) {
        log(`WebSocket 断开，Hub 当前不可达；等待恢复后立即重连... (${reason})`);
        retryDelay = WS_RETRY_START_MS;
        continue;
      }

      log(`WebSocket 断开，但 Hub 仍在线；${retryDelay / 1000}s 后重连... (${reason})`);
      await sleep(retryDelay);
      retryDelay = Math.min(retryDelay * 2, WS_RETRY_MAX_MS);
    }
  }
}

function persistToolIdentity(config: SessionConfig | null | undefined): void {
  const nextIdentity: Record<string, unknown> = { isChannel: false, lastSeenAt: new Date().toISOString() };
  if (config?.tag) nextIdentity.tag = config.tag;
  if (config?.description) nextIdentity.description = config.description;

  try {
    fs.mkdirSync(path.dirname(IDENTITIES_FILE), { recursive: true });
    const raw = fs.existsSync(IDENTITIES_FILE) ? fs.readFileSync(IDENTITIES_FILE, "utf-8") : "{}";
    const all = JSON.parse(raw);
    all[INSTANCE_ID] = { ...(all[INSTANCE_ID] ?? {}), ...nextIdentity };
    fs.writeFileSync(IDENTITIES_FILE, JSON.stringify(all, null, 2), "utf-8");
    if (config?.description) {
      log(`📝 工具模式描述传递: ${config.description}`);
    } else {
      log("🧰 工具模式已登记到实例列表");
    }
  } catch (err) {
    logError(`工具模式实例登记失败: ${String(err)}`);
  }
}

// ── MCP Channel Server ─────────────────────────────────────────────────────

mcpServer = new Server(
  { name: "hub", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      "你通过 Forge Hub 接收所有通道的消息。",
      '消息格式：<channel source="hub" hub_channel="wechat" sender="用户" sender_id="xxx">内容</channel>',
      "",
      "回复时用 hub_reply 工具，channel 参数填消息来源的通道名（如 wechat）。",
      "启动时 Hub 会自动推送近期历史（受 hub-config.json 的 auto_replay_on_ready/auto_replay_count 控制，default 开启/每通道 10 条）。你会收到 `【wechat 历史记录】...` 这类 system 消息。想拉更多或增量（since_ts）时用 hub_replay_history 工具。",
      "to 参数填消息的 sender_id。",
      "发文件用 hub_send_file，发语音用 hub_send_voice。",
      "",
      "管理操作用 Bash 调 forge CLI（如 `fh hub peers`、`fh hub channels`）。",
      "通道订阅：`fh hub listen wx tg` 设置监听通道（wx=微信, tg=Telegram, im=iMessage, fs=飞书, all=全部）。用户说「关掉微信」就跑 fh hub listen 去掉 wx。",
      "紧急锁定：收到「🔒 Hub 已锁定」表示用户从某个通道触发了安全锁定——所有远程通道已关闭（入站不转发、出站被拦截）。这是正常的安全功能，不是故障。锁定期间 hub_reply 会返回失败。等用户在 Terminal 解锁（`fh hub unlock`）后恢复。不需要你做任何事。",
      "不需要记忆 context_token 或其他通道内部状态，Hub 自动处理。",
    ].join("\n"),
  },
);

// ── Remote Approval: permission_request notification handler ──────────────

const PermissionRequestNotification = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

// 推送失败时 auto-deny——否则 Claude Code 的 permission handler 会无限等一个永远不来的 verdict。
async function autoDenyPermission(request_id: string, reason: string): Promise<void> {
  try {
    await mcpServer.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id, behavior: "deny" },
    });
    log(`🚨 auto-deny permission_request ${request_id}: ${reason}`);
  } catch (err) {
    logError(`autoDenyPermission 失败 (req=${request_id}): ${String(err)}`);
  }
}

mcpServer.setNotificationHandler(PermissionRequestNotification, async ({ params }) => {
  try {
    const res = await fetch(`${HUB_URL}/permission-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ ...params, instance: INSTANCE_ID }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "<read body failed>");
      let reason = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(body);
        if (parsed.error) reason = `${reason}: ${String(parsed.error).slice(0, 300)}`;
      } catch { /* body not JSON, use status only */ }
      logError(`permission_request ${reason} (req=${params.request_id})`);
      await autoDenyPermission(params.request_id, reason);
      return;
    }

    // 单独捕获 res.json() 自己的 SyntaxError，保留诊断信息
    let data: { success: boolean; error?: string; pushed?: string[]; failed?: string[] };
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      logError(
        `permission_request 响应非 JSON (req=${params.request_id}): ${String(err)}`,
      );
      await autoDenyPermission(params.request_id, "response not JSON");
      return;
    }

    if (!data.success) {
      logError(
        `permission_request 推送失败 (req=${params.request_id}): ${data.error}`,
      );
      await autoDenyPermission(params.request_id, "all channels failed");
      return;
    }

    // 部分通道失败——整体 success=true，但需要 fail-loud 让多通道配置的问题可见
    if (data.failed && data.failed.length > 0) {
      logError(
        `permission_request ${params.request_id} 部分通道失败: ${data.failed.join("; ")} ` +
          `(成功: ${(data.pushed ?? []).join(",")})`,
      );
    }

    log(`🔐 permission_request ${params.request_id} 已转发给 hub`);
  } catch (err) {
    // 网络层异常（fetch 失败、DNS、连接拒绝等）
    logError(
      `permission_request fetch 异常 (req=${params.request_id}): ${String(err)}`,
    );
    await autoDenyPermission(params.request_id, `fetch error: ${String(err).slice(0, 100)}`);
  }
});

// ── Tool Definitions ────────────────────────────────────────────────────────

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "hub_reply",
      description: "通过指定通道发送文本消息。",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: '通道名（如 "wechat"）' },
          to: { type: "string", description: "接收者 ID（sender_id）" },
          text: { type: "string", description: "消息文本" },
        },
        required: ["channel", "to", "text"],
      },
    },
    {
      name: "hub_send_file",
      description: "通过指定通道发送文件。",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: '通道名（如 "wechat"）' },
          to: { type: "string", description: "接收者 ID" },
          path: { type: "string", description: "文件路径或 HTTPS URL" },
        },
        required: ["channel", "to", "path"],
      },
    },
    {
      name: "hub_send_voice",
      description: "通过指定通道发送语音消息。",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: '通道名（如 "wechat"）' },
          to: { type: "string", description: "接收者 ID" },
          text: { type: "string", description: "要合成语音的文字" },
        },
        required: ["channel", "to", "text"],
      },
    },
    {
      name: "hub_replay_history",
      description: "主动拉取某通道最近 N 条聊天历史，返回格式化文本。当你觉得需要更多上下文（比如刚连上、或想回溯用户之前说了什么）时用。不会骚扰用户——这只是读本地 Hub 的 jsonl 文件。",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel: { type: "string", description: '通道名（如 "wechat"、"telegram"）' },
          limit: { type: "number", description: "拉取条数，default 50，max 500", default: 50 },
          since_ts: { type: "string", description: "可选 ISO 时间戳，只返回晚于此时间的历史（用于增量拉取）" },
        },
        required: ["channel"],
      },
    },
  ],
}));

// ── Tool Handlers ───────────────────────────────────────────────────────────

mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = (type: string) => ({ content: [{ type: "text" as const, text: type }] });

  // hub_reply
  if (req.params.name === "hub_reply") {
    const { channel, to, text: msg } = req.params.arguments as { channel: string; to: string; text: string };
    if (!msg) return text("错误: 缺少 text 参数（参数名是 text，不是 content）");
    try {
      const res = await fetch(`${HUB_URL}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ channel, to, text: msg, instance: INSTANCE_ID }),
      });
      const data = await res.json() as { success: boolean; error?: string; warning?: string };
      if (!data.success) return text(`发送失败: ${data.error}`);
      return text(data.warning ? `sent\n⚠️ ${data.warning}` : "sent");
    } catch (err) {
      return text(`Hub 连接失败: ${String(err)}`);
    }
  }

  // hub_send_file
  if (req.params.name === "hub_send_file") {
    const { channel, to, path } = req.params.arguments as { channel: string; to: string; path: string };
    try {
      const res = await fetch(`${HUB_URL}/send-file`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ channel, to, path, instance: INSTANCE_ID }),
      });
      const data = await res.json() as { success: boolean; error?: string; warning?: string };
      if (!data.success) return text(`发送失败: ${data.error}`);
      return text(data.warning ? `sent\n⚠️ ${data.warning}` : "sent");
    } catch (err) {
      return text(`Hub 连接失败: ${String(err)}`);
    }
  }

  // hub_send_voice
  if (req.params.name === "hub_send_voice") {
    const { channel, to, text: msg } = req.params.arguments as { channel: string; to: string; text: string };
    try {
      const res = await fetch(`${HUB_URL}/send-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ channel, to, text: msg, instance: INSTANCE_ID }),
      });
      const data = await res.json() as { success: boolean; error?: string; warning?: string };
      if (!data.success) return text(`发送失败: ${data.error}`);
      return text(data.warning ? `voice sent\n⚠️ ${data.warning}` : "voice sent");
    } catch (err) {
      return text(`Hub 连接失败: ${String(err)}`);
    }
  }

  // hub_replay_history
  if (req.params.name === "hub_replay_history") {
    const { channel, limit, since_ts } = req.params.arguments as { channel: string; limit?: number; since_ts?: string };
    const cap = Math.min(Math.max(1, limit ?? 50), 500);
    try {
      const qs = new URLSearchParams({ channel, limit: String(cap) });
      if (since_ts) qs.set("since_ts", since_ts);
      const res = await fetch(`${HUB_URL}/history?${qs.toString()}`, { headers: authHeaders() });
      if (!res.ok) return text(`Hub /history HTTP ${res.status}`);
      const data = (await res.json()) as { channel: string; history: { ts: string; direction?: string; from?: string; text?: string }[] };
      if (!data.history || data.history.length === 0) {
        return text(`【${channel} 历史】无匹配条目${since_ts ? `（since ${since_ts}）` : ""}`);
      }
      const lines = data.history.map((h) => {
        const time = new Date(h.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        const arrow = h.direction === "in" ? "←" : h.direction === "out" ? "→" : "·";
        return `${time} ${arrow} ${h.from ?? "?"}: ${h.text ?? ""}`;
      });
      return text(`【${channel} 历史 · ${data.history.length} 条】\n${lines.join("\n")}`);
    } catch (err) {
      return text(`Hub 连接失败: ${String(err)}`);
    }
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  await mcpServer.connect(new StdioServerTransport());
  log("MCP 连接就绪");

  // Channel mode = has channels subscription. Tool mode = no channels (even if has description)
  const isChannel = isChannelMode(SESSION_CONFIG);

  // Tool mode: persist identity so Hub/Dashboard can show this instance as "仅工具"
  if (!isChannel) {
    persistToolIdentity(SESSION_CONFIG);
  }

  if (isChannel) {
    void connectWithRetry();
    log(`Hub Client 已启动 ✦ WebSocket channel 模式 (instance: ${INSTANCE_ID})`);
  } else {
    const hubReady = await ensureHubRunning();
    if (!hubReady) {
      log("⚠ Hub 未就绪，工具调用会失败。请启动 Hub 或使用直连模式。");
    }
    log(`Hub Client 已启动 · 工具模式（不注册 peer）`);
  }
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
