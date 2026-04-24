/**
 * Forge Hub — HTTP + WebSocket endpoints
 *
 * 所有 HTTP endpoints 和 WebSocket upgrade 都在这里。依赖全部通过 import
 * 拿到——hub.ts main() 负责填 state（populate registry, loadPendingFromDisk,
 * setCurrentConfig）再 startServer，所以本模块不碰初始化，只负责 serve。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import type { HubConfig, InboundHandleResult, WsData } from "./types.js";
import {
  HUB_NAME,
  HUB_VERSION,
  HUB_DIR,
  log,
  logError,
  appendAudit,
  isLocked,
  getLockState,
  readAuthToken,
  deriveHealthStatus,
  getAllChannelHealth,
  getChannelHealth,
  redactSensitive,
} from "./config.js";
import {
  handleWsOpen,
  handleWsMessage,
  handleWsClose,
  getInstances,
  listKnownInstances,
  pushToInstances,
  setInstanceTag,
  setInstanceDescription,
  setInstanceChannels,
  setSummary,
} from "./instance-manager.js";
import { addReplyTag } from "./router.js";
import { loadChannelState } from "./state.js";
import { channelPlugins, channelPluginsMeta } from "./channel-registry.js";
import {
  pendingPermissions,
  idLookup,
  PERMISSION_TTL_MS,
  genDisplayIdPair,
  savePendingToDisk,
  resolveApprovalRecipient,
  resolveApprovalFromDashboard,
  dismissApprovalFromDashboard,
} from "./approval.js";
import {
  addSSEClient,
  removeSSEClient,
  broadcastHomelandApproval,
  broadcastHomelandStatus,
} from "./channels/homeland.js";
import { triggerLock, triggerUnlock } from "./lock.js";
import { checkPermissionRate, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./rate-limit.js";
import { resolveRecipient } from "./resolve.js";
import { appendHistory, getOutboundFrom, readRecentHistory } from "./history.js";
import { synthesizeToOgg } from "./tts.js";
import { getCurrentConfig, startedAt } from "./hub-state.js";

const DASHBOARD_AUTH_COOKIE = "forge_hub_dashboard";
const DASHBOARD_DIR_CANDIDATES = [
  process.env.FORGE_HUB_DASHBOARD_DIR,
  path.join(import.meta.dir, "hub-dashboard", "dist"),
  path.join(import.meta.dir, "..", "hub-dashboard", "dist"),
].filter((entry): entry is string => Boolean(entry));
const DASHBOARD_MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

function normalizeApiPath(pathname: string): string {
  if (pathname === "/api" || pathname === "/api/") return "/";
  if (pathname.startsWith("/api/")) return pathname.slice(4);
  return pathname;
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.get("Cookie") ?? "";
  const parsed: Record<string, string> = {};
  for (const chunk of raw.split(";")) {
    const [name, ...rest] = chunk.trim().split("=");
    if (!name) continue;
    parsed[name] = decodeURIComponent(rest.join("="));
  }
  return parsed;
}

function dashboardAuthDigest(apiToken: string): string {
  return crypto.createHash("sha256").update(`forge-hub-dashboard:${apiToken}`).digest("hex");
}

function hasDashboardSession(req: Request, apiToken: string): boolean {
  if (!apiToken) return false;
  const cookies = parseCookies(req);
  return cookies[DASHBOARD_AUTH_COOKIE] === dashboardAuthDigest(apiToken);
}

function buildDashboardAuthCookie(apiToken: string): string {
  return `${DASHBOARD_AUTH_COOKIE}=${dashboardAuthDigest(apiToken)}; Path=/; HttpOnly; SameSite=Strict`;
}

function clearDashboardAuthCookie(): string {
  return `${DASHBOARD_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function trustedDashboardOrigins(url: URL): Set<string> {
  const origins = new Set<string>([url.origin]);
  const port = url.port ? `:${url.port}` : "";
  origins.add(`${url.protocol}//localhost${port}`);
  origins.add(`${url.protocol}//127.0.0.1${port}`);
  origins.add(`${url.protocol}//[::1]${port}`);
  const configured = process.env.FORGE_HUB_DASHBOARD_ORIGINS ?? "";
  for (const origin of configured.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    origins.add(origin);
  }
  return origins;
}

function hasTrustedDashboardOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return true;
  return trustedDashboardOrigins(url).has(origin);
}

function requiresDashboardOriginCheck(req: Request, routePath: string, isWsUpgrade: boolean): boolean {
  return (
    isWsUpgrade ||
    (req.method === "GET" && routePath === "/homeland/stream") ||
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
  );
}

function shouldRejectUntrustedBrowserOrigin(req: Request, url: URL, routePath: string, isWsUpgrade: boolean): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  if (!requiresDashboardOriginCheck(req, routePath, isWsUpgrade)) return false;
  return !trustedDashboardOrigins(url).has(origin);
}

function trustedDashboardCorsHeaders(req: Request, url: URL): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin || !trustedDashboardOrigins(url).has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
  };
}

function buildPublicHealth() {
  return {
    ok: true,
    name: HUB_NAME,
    version: HUB_VERSION,
    uptime: Math.round(process.uptime()),
    locked: isLocked(),
  };
}

function buildDetailedStatus() {
  const instances = listKnownInstances();
  const health = getAllChannelHealth();
  const mem = process.memoryUsage();
  return {
    hub: {
      version: HUB_VERSION,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      memory_mb: Math.round(mem.rss / 1024 / 1024),
      started_at: startedAt,
      lock: getLockState(),
      locked: isLocked(),
    },
    channels: Object.fromEntries(
      [...channelPlugins.keys()].map(ch => {
        const h = health[ch] ?? { messagesIn: 0, messagesOut: 0, errors: 0, consecutiveFailures: 0, consecutiveSuccesses: 0 };
        return [ch, {
          loaded: true,
          ...h,
          health_status: deriveHealthStatus(h as any),
        }];
      })
    ),
    instances: instances.map((i) => ({
      id: i.id,
      tag: i.tag,
      description: i.description,
      isChannel: i.isChannel,
      channels: i.channels,
      presence: i.presence,
      connectedAt: i.connectedAt,
      lastSeenAt: i.lastSeenAt,
    })),
  };
}

function resolveDashboardDir(): string | null {
  for (const candidate of DASHBOARD_DIR_CANDIDATES) {
    const root = path.resolve(candidate);
    try {
      if (fs.existsSync(path.join(root, "index.html"))) {
        return root;
      }
    } catch {}
  }
  return null;
}

function resolveDashboardStaticFile(pathname: string): string | null {
  const dashboardDir = resolveDashboardDir();
  if (!dashboardDir) return null;
  const rawRelative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const normalizedRelative = path.posix.normalize(rawRelative);
  if (!normalizedRelative || normalizedRelative.startsWith("..")) return null;
  const filePath = path.resolve(dashboardDir, normalizedRelative);
  const dashboardRoot = path.resolve(dashboardDir);
  if (!filePath.startsWith(dashboardRoot + path.sep) && filePath !== dashboardRoot) return null;
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return filePath;
    }
  } catch {}
  return null;
}

function serveDashboardFile(filePath: string): Response {
  const ext = path.extname(filePath).toLowerCase();
  return new Response(Bun.file(filePath), {
    headers: { "Content-Type": DASHBOARD_MIME_TYPES[ext] ?? "application/octet-stream" },
  });
}

function isDashboardStaticRequest(req: Request, url: URL): boolean {
  if (req.method !== "GET") return false;
  return resolveDashboardStaticFile(url.pathname) !== null;
}

function mapHomelandIngressFailure(result: InboundHandleResult): { status: number; error: string } {
  switch (result.reason) {
    case "allowlist_error":
    case "unauthorized_sender":
      return {
        status: 403,
        error:
          result.detail
            ? `Homeland Operator 未授权：${result.detail}`
            : "Homeland Operator 未授权。先运行 `fh hub allow homeland local://operator Operator`。",
      };
    case "locked":
      return { status: 423, error: "Hub 已锁定，Homeland 消息未转发" };
    case "no_online_instance":
    case "no_subscribed_instance":
    case "unresolved_mention":
    case "ambiguous_mention":
    case "ambiguous_route":
      return {
        status: 409,
        error: result.detail ?? `消息未送达（${result.reason}）`,
      };
    case "handler_missing":
      return { status: 503, error: "Hub Homeland 入站处理器未注册" };
    case "internal_error":
      return { status: 500, error: result.detail ?? "Homeland 入站处理失败" };
    default:
      return {
        status: 409,
        error: result.detail ?? `Homeland 消息未送达（${result.reason}）`,
      };
  }
}

/**
 * 出站前检查通道健康。
 * - unhealthy → refuse（返回 error，不 try）
 * - degraded → warn + try
 * - healthy/unknown → 正常
 *
 * 死锁防御：deriveHealthStatus 有 10 分钟 natural decay——最后一次
 * failure 超过 10 分钟后 status 自动回 unknown，出站恢复正常 try。
 */
function checkChannelHealth(channel: string): Response | null {
  const health = getChannelHealth(channel);
  const status = deriveHealthStatus(health);
  if (status === "unhealthy") {
    log(`⛔ 通道 ${channel} unhealthy（连续 ${health.consecutiveFailures} 次失败），拒绝出站`);
    return Response.json({
      success: false,
      error: `通道 ${channel} 当前 unhealthy（连续 ${health.consecutiveFailures} 次失败，最近: ${health.lastError?.slice(0, 80) ?? "?"}）。等待自动恢复（~10 分钟）或重启 hub。`,
      health_status: status,
    });
  }
  if (status === "degraded") {
    log(`⚠️ 通道 ${channel} degraded（连续 ${health.consecutiveFailures} 次失败），尝试发送`);
  }
  return null; // proceed
}

/**
 * 构造发送风险警告——成功但风险高的场景。
 * degraded（最近出错）或入站长时间无消息（轮询可能挂但出站还通）时返回文案，
 * agent 看到 warning 可以决定换通道重发或向用户确认。healthy 时返回 undefined。
 */
function buildSendWarning(channel: string): string | undefined {
  const health = getChannelHealth(channel);
  const status = deriveHealthStatus(health);
  const warnings: string[] = [];

  if (status === "degraded") {
    warnings.push(`通道 ${channel} 最近连续 ${health.consecutiveFailures} 次失败${health.lastError ? `（最近错误: ${health.lastError.slice(0, 60)}）` : ""}`);
  }

  // 入站长时间无消息——可能轮询挂了（出站可能还通），对方回复我们收不到
  if (health.lastMessageIn) {
    const mins = Math.floor((Date.now() - new Date(health.lastMessageIn).getTime()) / 60000);
    if (mins > 10) {
      warnings.push(`通道 ${channel} 入站已 ${mins} 分钟无消息，轮询可能挂了。如果对方回了你可能看不到`);
    }
  }

  return warnings.length > 0 ? warnings.join("；") + "。送达状态不确定，建议关注或换通道确认。" : undefined;
}

export function startServer(config: HubConfig): void {
  Bun.serve<WsData>({
    port: config.port,
    hostname: config.host,
    idleTimeout: 0,

    // ── WebSocket Handler ──────────────────────────────────────────────────
    websocket: {
      open(ws) { handleWsOpen(ws); },
      message(ws, msg) { handleWsMessage(ws, msg); },
      close(ws) { handleWsClose(ws); },
      sendPings: true,
    },

    async fetch(req, server) {
      const url = new URL(req.url);
      const routePath = normalizeApiPath(url.pathname);

      // ── 可选 API Token 鉴权 ──────────────────────────────────────────────
      // 开源场景：本机多用户 / Hub bind 到 0.0.0.0 时，任何本机/网络进程都能 POST 消息。
      // 设置 HUB_API_TOKEN env 启用验证——所有非豁免的请求必须带
      // `Authorization: Bearer <token>`。default 不验（保持用户本机 localhost-only 的当前行为）。
      //
      // 豁免清单（严格）：
      //   - GET /health：公开健康检查入口，只返回最小状态
      //
      // WebSocket /ws：token 通过 query param `?token=` 传递（WebSocket 标准不允许
      // browser 改 header；Bun-side 保持 query-param 便于跨实现兼容）。之前 /ws 豁免
      // 导致任何本机/网络进程可伪造 instance ID 接管现有连接并劫持通道消息——redteam B1。
      //
      // 其他所有 GET（如 /status、/pending、/instances、/channels、/history）**都必须带 token**——
      // 它们暴露 pending 审批的 yes_id/no_id、实例列表、聊天历史等敏感数据。
      const apiToken = readAuthToken();
      const isWsUpgrade = req.method === "GET" && routePath === "/ws";
      const isPublicHealthCheck = req.method === "GET" && routePath === "/health";
      const isDashboardStatic = isDashboardStaticRequest(req, url);
      const isDashboardAuth = req.method === "POST" && routePath === "/dashboard-auth";
      const isDashboardLogout = req.method === "POST" && routePath === "/dashboard-logout";
      const hasDashboardCookie = hasDashboardSession(req, apiToken);

      // Browser origin is a separate trust boundary from the localhost process
      // model. Even in no-token mode, a random webpage must not be able to
      // register a WS instance, subscribe to SSE, or mutate Hub state via CSRF.
      if (shouldRejectUntrustedBrowserOrigin(req, url, routePath, isWsUpgrade)) {
        return Response.json({ error: "forbidden_origin" }, { status: 403 });
      }

      if (apiToken && !isPublicHealthCheck && !isDashboardStatic && !isDashboardAuth && !isDashboardLogout) {
        let providedToken = "";
        if (isWsUpgrade || (req.method === "GET" && routePath === "/homeland/stream")) {
          providedToken = url.searchParams.get("token") ?? "";
        } else {
          const authHeader = req.headers.get("Authorization") ?? "";
          providedToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        }
        const hasBearerToken = providedToken === apiToken;
        if (!hasBearerToken && !hasDashboardCookie) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        if (!hasBearerToken && hasDashboardCookie && requiresDashboardOriginCheck(req, routePath, isWsUpgrade) && !hasTrustedDashboardOrigin(req, url)) {
          return Response.json({ error: "forbidden_origin" }, { status: 403 });
        }
      }

      // GET /ws — WebSocket 实例连接
      if (req.method === "GET" && routePath === "/ws") {
        const instanceId = url.searchParams.get("instance");
        if (!instanceId) {
          return new Response("missing instance parameter", { status: 400 });
        }
        const ok = server.upgrade(req, { data: { instanceId } });
        if (ok) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // GET /health — public minimal health check
      if (req.method === "GET" && routePath === "/health") {
        return Response.json(buildPublicHealth());
      }

      // GET /status — authenticated detailed status
      if (req.method === "GET" && routePath === "/status") {
        return Response.json(buildDetailedStatus());
      }

      // POST /dashboard-auth — 浏览器登录，成功后写 HttpOnly cookie
      if (req.method === "POST" && routePath === "/dashboard-auth") {
        try {
          if (!apiToken) {
            return Response.json(
              { success: true, auth_required: false },
              { headers: { "Set-Cookie": clearDashboardAuthCookie() } },
            );
          }
          const body = await req.json() as { token?: string };
          if (!body.token) {
            return Response.json({ success: false, error: "缺少 token" }, { status: 400 });
          }
          if (body.token !== apiToken) {
            return Response.json({ success: false, error: "token 不正确" }, { status: 401 });
          }
          return Response.json(
            { success: true, auth_required: false },
            { headers: { "Set-Cookie": buildDashboardAuthCookie(apiToken) } },
          );
        } catch (err) {
          return Response.json({ success: false, error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // POST /dashboard-logout — 清除浏览器 cookie
      if (req.method === "POST" && routePath === "/dashboard-logout") {
        return Response.json(
          { success: true },
          { headers: { "Set-Cookie": clearDashboardAuthCookie() } },
        );
      }

      // GET /pending — 列出当前挂起的审批（用户可观测性）
      if (req.method === "GET" && routePath === "/pending") {
        const now = Date.now();
        const pending = [...pendingPermissions.values()].map((p) => ({
          request_id: p.request_id,
          yes_id: p.yes_id,
          no_id: p.no_id,
          tool_name: p.tool_name,
          description: p.description,
          from_instance: p.from_instance,
          created_at: new Date(p.created_at).toISOString(),
          waited_seconds: Math.round((now - p.created_at) / 1000),
          remaining_seconds: Math.max(0, Math.round((PERMISSION_TTL_MS - (now - p.created_at)) / 1000)),
          pushed_channels: p.pushed_channels,
        }));
        return Response.json({ count: pending.length, pending });
      }

      // GET /instances
      if (req.method === "GET" && routePath === "/instances") {
        const list = listKnownInstances().map((i) => ({
          id: i.id,
          tag: i.tag,
          description: i.description,
          isChannel: i.isChannel,
          channels: i.channels,
          presence: i.presence,
          connectedAt: i.connectedAt,
          lastSeenAt: i.lastSeenAt,
          summary: i.summary,
        }));
        return Response.json({ instances: list });
      }

      // GET /channels
      if (req.method === "GET" && routePath === "/channels") {
        const meta = [...channelPluginsMeta.values()].map(p => ({
          id: p.name, name: p.displayName, aliases: p.aliases,
        }));
        return Response.json({ channels: meta });
      }

      // POST /lock
      if (req.method === "POST" && routePath === "/lock") {
        if (!isLocked()) {
          triggerLock("cli");
        }
        return Response.json({ success: true, locked: true });
      }

      // POST /unlock
      if (req.method === "POST" && routePath === "/unlock") {
        if (isLocked()) {
          triggerUnlock();
        }
        return Response.json({ success: true, locked: false });
      }

      // ── Lock guard for all outbound endpoints ────────────────────────────
      if (isLocked() && req.method === "POST" && (routePath === "/send" || routePath === "/send-file" || routePath === "/send-voice")) {
        try {
          const body = await req.json() as { channel?: string; text?: string; instance?: string; path?: string };
          const who = body.instance ?? "unknown";
          const what = body.text?.slice(0, 60) ?? body.path?.split("/").pop() ?? "";
          log(`🔒 出站拦截 [${body.channel ?? "?"}] ${who}: ${what} [已锁定]`);
        } catch {}
        return Response.json({ success: false, error: "Hub 已锁定" });
      }

      // POST /permission-request — 实例发起远程审批请求
      if (req.method === "POST" && routePath === "/permission-request") {
        try {
          const body = await req.json() as {
            request_id: string;
            tool_name: string;
            description: string;
            input_preview: string;
            instance: string;
          };

          // 1. 校验 request_id 格式（5 小写字母，不含 'l'）
          if (!/^[a-km-z]{5}$/.test(body.request_id)) {
            return Response.json(
              { success: false, error: "invalid request_id format (must be 5 lowercase letters, no 'l')" },
              { status: 400 },
            );
          }

          // 1.5 Rate limit——防 rogue instance spam 用户
          if (!checkPermissionRate(body.instance)) {
            logError(`⚠️ /permission-request rate limit 触发 (instance=${body.instance}, request_id=${body.request_id})`);
            return Response.json(
              { success: false, error: `rate limited: max ${RATE_LIMIT_MAX} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s per instance` },
              { status: 429 },
            );
          }

          // 2. 锁定期间不推送审批
          if (isLocked()) {
            return Response.json(
              { success: false, error: "hub locked, remote approval disabled" },
              { status: 503 },
            );
          }

          // 3. 读配置中的 approval_channels
          // Note (redteam 2nd round S1): handler 内 getCurrentConfig() 只调一
          // 次，把 ref 存到 local const——跨多个 await 保持快照一致。对比 baseline
          // (hub.ts module-let) 是 semantic drift 但方向更好：整条 request 用同
          // 一 config，避免 half-old half-new 的 hot-reload race。
          const currentConfig = getCurrentConfig();
          const channels = currentConfig.approval_channels ?? [];
          if (channels.length === 0) {
            // Actionable error: surface next step to the agent. In server:hub mode CC
            // auto-denies on this 503 (see hub-channel.ts autoDenyPermission) — without
            // the fix hint the user sees "Tool use rejected" with no idea how to unblock.
            return Response.json(
              {
                success: false,
                error:
                  "no approval_channels configured — edit ~/.forge-hub/hub-config.json and set approval_channels (e.g. [\"wechat\"]); " +
                  "server:hub mode requires at least one channel to route approval prompts to. See 配置.md §审批推送配置.",
              },
              { status: 503 },
            );
          }

          // 4. ID 冲突快速失败（让客户端重新生成 ID 重试）
          if (pendingPermissions.has(body.request_id)) {
            return Response.json(
              { success: false, error: `request_id ${body.request_id} conflict with an active pending` },
              { status: 409 },
            );
          }

          // 5. 生成独立的 yes_id / no_id，强绑定 verdict 语义
          const { yes_id, no_id } = genDisplayIdPair();

          // 6. 登记 pending + idLookup 双写
          pendingPermissions.set(body.request_id, {
            request_id: body.request_id,
            yes_id,
            no_id,
            tool_name: body.tool_name,
            description: body.description,
            input_preview: body.input_preview,
            from_instance: body.instance,
            created_at: Date.now(),
            pushed_channels: [],
          });
          idLookup.set(yes_id, { request_id: body.request_id, behavior: "allow" });
          idLookup.set(no_id, { request_id: body.request_id, behavior: "deny" });
          savePendingToDisk();

          // 7. 构造提示文案——yes/no 用不同 id，配错任何一边都会被拒（防手滑）
          const promptLines = [
            `Claude wants to run ${body.tool_name}: ${body.description}`,
          ];
          if (body.input_preview) promptLines.push("", body.input_preview.slice(0, 200));
          promptLines.push("", "Allow?", `Reply "yes ${yes_id}" to approve`, `Reply "no ${no_id}" to deny`);
          const prompt = promptLines.join("\n");

          // 7. 推送到 approval_channels——支持两种模式
          // - "parallel"（default）：并发所有通道，任一成功即算登记成功。适合用户场景（4 通道都通，可靠性最高）
          // - "sequential"：按顺序尝试，第一个成功就停。适合 fallback 优先级（如 wechat 优先，挂了再 tg）
          const pushAllChannel = async (chName: string) => {
            const plugin = channelPlugins.get(chName);
            if (!plugin) throw new Error(`channel ${chName} not registered`);
            const to = await resolveApprovalRecipient(chName);
            if (!to) throw new Error(`no approval recipient for ${chName}`);
            const ctxTokens = (loadChannelState(chName, "context-tokens") ?? {}) as Record<string, string>;
            const contextToken = ctxTokens[to] ?? "";
            const r = await plugin.send({
              to,
              content: prompt,
              type: "text",
              raw: { context_token: contextToken },
            });
            if (!r.success) throw new Error(r.error || "send failed");
            return chName;
          };

          const successful: string[] = [];
          const failures: string[] = [];
          if (currentConfig.approval_push_mode === "sequential") {
            // 按顺序尝试，遇到第一个成功就停（剩余通道不尝试）
            for (const chName of channels) {
              try {
                await pushAllChannel(chName);
                successful.push(chName);
                break; // 一个成功就停
              } catch (err) {
                failures.push(`${chName}: ${redactSensitive(String(err))}`);
              }
            }
          } else {
            // parallel（default）
            const pushResults = await Promise.allSettled(channels.map(pushAllChannel));
            for (const r of pushResults) {
              if (r.status === "fulfilled") successful.push(r.value);
              else failures.push(redactSensitive(String(r.reason)));
            }
          }

          // 8. 全部失败 → 清 pending + idLookup 返回 502
          if (successful.length === 0) {
            pendingPermissions.delete(body.request_id);
            idLookup.delete(yes_id);
            idLookup.delete(no_id);
            savePendingToDisk();
            log(`❌ 审批 ${body.request_id} 全通道推送失败: ${failures.join("; ")}`);
            appendAudit({
              action: "approval_push_failed",
              request_id: body.request_id,
              tool_name: body.tool_name,
              from_instance: body.instance,
              failures,
            });
            return Response.json(
              { success: false, error: `all channels failed: ${failures.join("; ")}` },
              { status: 502 },
            );
          }

          // 9. 更新 pushed_channels（调试用）
          const pending = pendingPermissions.get(body.request_id)!;
          pending.pushed_channels = successful;

          broadcastHomelandApproval({
            request_id: body.request_id, yes_id, no_id,
            tool_name: body.tool_name, description: body.description,
            from_instance: body.instance,
          });
          log(`🔐 审批 ${body.request_id} 已推送到 [${successful.join(",")}] (tool=${body.tool_name})`);
          if (failures.length > 0) log(`   部分失败: ${failures.join("; ")}`);
          appendAudit({
            action: "approval_pushed",
            request_id: body.request_id,
            yes_id,
            no_id,
            tool_name: body.tool_name,
            description: body.description,
            from_instance: body.instance,
            pushed_channels: successful,
            failed_channels: failures,
          });
          return Response.json({ success: true, pushed: successful, failed: failures });
        } catch (err) {
          const redacted = redactSensitive(String(err));
          logError(`/permission-request 处理失败: ${redacted}`);
          return Response.json({ success: false, error: redacted }, { status: 500 });
        }
      }

      // POST /send
      if (req.method === "POST" && routePath === "/send") {
        try {
          const body = await req.json() as {
            channel: string;
            to: string;
            text: string;
            instance?: string;
          };

          if (!body.text) {
            return Response.json({ success: false, error: "缺少 text 参数" }, { status: 400 });
          }

          // Instance-to-instance communication: channel="hub"
          if (body.channel === "hub") {
            const instances = getInstances();
            const target = body.to.replace(/^@/, "");
            // Find by tag first, then by ID
            let targetId: string | null = null;
            for (const [id, inst] of instances) {
              if (inst.tag === target) { targetId = id; break; }
            }
            if (!targetId && instances.has(target)) targetId = target;

            // Get sender info
            const senderInst = body.instance ? instances.get(body.instance) : null;
            const senderLabel = senderInst?.description ?? senderInst?.tag ?? body.instance ?? "unknown";

            // Broadcast to all (except sender) or targeted
            const targetIds = target === "all"
              ? [...instances.keys()].filter((id) => id !== body.instance)
              : targetId ? [targetId] : null;
            if (!targetIds) {
              return Response.json({ success: false, error: `找不到实例: ${body.to}` });
            }

            pushToInstances(targetIds, {
              type: "instance_message",
              channel: "hub",
              from: senderLabel,
              fromId: body.instance ?? "",
              content: body.text,
              targeted: true,
              raw: {},
            });

            log(`↔ [hub] ${senderLabel} → ${target}: ${body.text.slice(0, 60)}`);
            return Response.json({ success: true });
          }

          const plugin = channelPlugins.get(body.channel);
          if (!plugin) {
            return Response.json({ error: `unknown channel: ${body.channel}` }, { status: 404 });
          }
          const healthBlock = checkChannelHealth(body.channel);
          if (healthBlock) return healthBlock;

          // Resolve nickname → ID via allowlist
          const resolvedTo = resolveRecipient(body.channel, body.to);
          if (!resolvedTo.ok) {
            return Response.json({ success: false, error: resolvedTo.error });
          }
          const to = resolvedTo.id;

          // Auto-inject context_token
          const contextTokens = (loadChannelState(body.channel, "context-tokens") ?? {}) as Record<string, string>;
          const contextToken = contextTokens[to] ?? "";

          // Add reply tag if multiple instances online
          const instances = getInstances();
          const taggedText = addReplyTag(body.text, body.instance ?? "", instances.size, getCurrentConfig(), instances);

          const senderInstance = getInstances().get(body.instance ?? "");
          const result = await plugin.send({
            to,
            content: taggedText,
            type: "text",
            raw: {
              context_token: contextToken,
              from_instance: body.instance ?? "",
              from_instance_tag: senderInstance?.description ?? senderInstance?.tag ?? "agent",
            },
          });

          if (result.success) {
            appendHistory(body.channel, "out", getOutboundFrom(body.instance), body.text);
            log(`→ [${body.channel}] ${body.to.slice(0, 16)}...: ${body.text.slice(0, 60)}`);
          }

          // 成功时注入 warning（degraded / 入站久无消息等风险提示）
          if (result.success) {
            const warning = buildSendWarning(body.channel);
            if (warning) return Response.json({ ...result, warning });
          }
          return Response.json(result);
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // POST /send-file
      if (req.method === "POST" && routePath === "/send-file") {
        try {
          const body = await req.json() as {
            channel: string;
            to: string;
            path: string;
            instance?: string;
          };

          const plugin = channelPlugins.get(body.channel);
          if (!plugin) {
            return Response.json({ error: `unknown channel: ${body.channel}` }, { status: 404 });
          }
          const healthBlock = checkChannelHealth(body.channel);
          if (healthBlock) return healthBlock;

          // Security (redteam B2): path sandbox. 之前 path 无限制，attacker 可
          // POST /send-file 指向 /Users/victim/.ssh/id_rsa 发到 allowlist 内的
          // attacker chat。限制：HTTP(S) URL 放行 plugin 下载；本地 path 必须
          // realpath 落在 $HUB_DIR/sendable/ 内，防 symlink / .. 绕过。
          const isRemoteUrl = /^https?:\/\//i.test(body.path);
          if (!isRemoteUrl) {
            const sendableRoot = `${HUB_DIR}/sendable`;
            try {
              fs.mkdirSync(sendableRoot, { recursive: true });
              const realPath = fs.realpathSync(body.path);
              const realRoot = fs.realpathSync(sendableRoot);
              if (!realPath.startsWith(realRoot + "/") && realPath !== realRoot) {
                return Response.json(
                  { success: false, error: `path 必须在 ${sendableRoot}/ 下（HTTP/HTTPS URL 除外）` },
                  { status: 403 },
                );
              }
            } catch (err) {
              return Response.json(
                { success: false, error: `path 校验失败: ${redactSensitive(String(err))}` },
                { status: 400 },
              );
            }
          }

          const resolvedFile = resolveRecipient(body.channel, body.to);
          if (!resolvedFile.ok) return Response.json({ success: false, error: resolvedFile.error });
          const fileTo = resolvedFile.id;

          const contextTokens = (loadChannelState(body.channel, "context-tokens") ?? {}) as Record<string, string>;
          const contextToken = contextTokens[fileTo] ?? "";

          const result = await plugin.send({
            to: fileTo,
            content: "",
            type: "file",
            filePath: body.path,
            raw: { context_token: contextToken },
          });

          if (result.success) {
            const fileName = body.path.split("/").pop() ?? body.path;
            appendHistory(body.channel, "out", getOutboundFrom(body.instance), `[文件] ${fileName}`);
            log(`→ [${body.channel}] 文件: ${body.path.slice(0, 60)}`);
          }

          // 成功时注入 warning（degraded / 入站久无消息等风险提示）
          if (result.success) {
            const warning = buildSendWarning(body.channel);
            if (warning) return Response.json({ ...result, warning });
          }
          return Response.json(result);
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // POST /send-voice
      if (req.method === "POST" && routePath === "/send-voice") {
        try {
          const body = await req.json() as {
            channel: string;
            to: string;
            text: string;
            instance?: string;
          };

          const plugin = channelPlugins.get(body.channel);
          if (!plugin) {
            return Response.json({ error: `unknown channel: ${body.channel}` }, { status: 404 });
          }
          const healthBlock = checkChannelHealth(body.channel);
          if (healthBlock) return healthBlock;

          const resolvedVoice = resolveRecipient(body.channel, body.to);
          if (!resolvedVoice.ok) return Response.json({ success: false, error: resolvedVoice.error });
          const voiceTo = resolvedVoice.id;

          const contextTokens = (loadChannelState(body.channel, "context-tokens") ?? {}) as Record<string, string>;
          const contextToken = contextTokens[voiceTo] ?? "";

          let result;
          if (body.channel === "wechat") {
            // 微信走自己的 TTS → mp3 附件路径（iLink 不接 silk 原生语音，见 wechat-media.ts 注释）
            result = await plugin.send({
              to: voiceTo,
              content: body.text,
              type: "voice",
              raw: { context_token: contextToken },
            });
          } else {
            // Other channels: Hub does TTS → ogg, plugin sends the file
            const oggPath = await synthesizeToOgg(body.text);
            if (!oggPath) {
              return Response.json({ success: false, error: "TTS 合成失败" });
            }
            result = await plugin.send({
              to: voiceTo,
              content: body.text,
              type: "voice",
              filePath: oggPath,
              raw: { context_token: contextToken },
            });
            try { await fs.promises.rm(path.dirname(oggPath), { recursive: true, force: true }); } catch {}
          }

          if (result.success) {
            appendHistory(body.channel, "out", getOutboundFrom(body.instance), `[语音] ${body.text.slice(0, 60)}`);
            log(`→ [${body.channel}] 语音: ${body.text.slice(0, 60)}`);
          }

          // 成功时注入 warning（degraded / 入站久无消息等风险提示）
          if (result.success) {
            const warning = buildSendWarning(body.channel);
            if (warning) return Response.json({ ...result, warning });
          }
          return Response.json(result);
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // GET /history — 支持 limit + since_ts 过滤，用于 pull-model history 拉取
      if (req.method === "GET" && routePath === "/history") {
        try {
          const channel = url.searchParams.get("channel") ?? "wechat";
          // Security (redteam 终审 P1-4): channel 参数必须在 registered plugin
          // 白名单内——否则 "?channel=../../foo" 会 path-traverse 到
          // $HUB_DIR/state/../../foo/chat-history.jsonl，探测任意目录。
          if (!channelPlugins.has(channel)) {
            return Response.json({ error: `unknown channel: ${channel}` }, { status: 400 });
          }
          // redteam r2 L6: parseInt NaN / 负数 / 极大值都让 slice(-N) 退化成
          // 返回全部历史——几十 MB JSON → 本机 Hub memory DoS。clamp 到 [1, 1000]。
          let limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
          if (!Number.isFinite(limit) || limit <= 0 || limit > 1000) limit = 200;
          const sinceTs = url.searchParams.get("since_ts");  // ISO 时间，可选
          const recent = await readRecentHistory(channel, limit, sinceTs ?? undefined);
          return Response.json({ channel, history: recent });
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // POST /set-tag
      if (req.method === "POST" && (routePath === "/set-tag" || routePath === "/set-name")) {
        try {
          const body = await req.json() as { instance: string; tag?: string; name?: string };
          const ok = setInstanceTag(body.instance, body.tag ?? body.name ?? "");
          return Response.json({ success: ok });
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // POST /set-description
      if (req.method === "POST" && routePath === "/set-description") {
        try {
          const body = await req.json() as { instance: string; description: string };
          const ok = setInstanceDescription(body.instance, body.description);
          return Response.json({ success: ok });
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // POST /set-channels
      if (req.method === "POST" && routePath === "/set-channels") {
        try {
          const body = await req.json() as { instance: string; channels?: string[] };
          const channels = body.channels?.includes("all") ? undefined : body.channels;
          const ok = setInstanceChannels(body.instance, channels);
          return Response.json({ success: ok });
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // POST /set-summary — 实例工作描述（per-session，只在线时存在，不持久化）
      if (req.method === "POST" && routePath === "/set-summary") {
        try {
          const body = await req.json() as { instance: string; summary: string };
          const ok = setSummary(body.instance, body.summary);
          return Response.json({ success: ok });
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // DELETE /pending/<id> — 手动清除 stale pending（当 CC 本地 resolved 但 hub 没收到 cancel 时）
      // 设计理由：Channels Reference 没有 permission_cancel notification 协议，CC 本地 resolve 后
      // hub 不知道；stale pending 残留到 240min TTL 烦人。这个 endpoint 让 agent 或管理员手动清。
      if (req.method === "DELETE" && routePath.startsWith("/pending/")) {
        const id = decodeURIComponent(routePath.slice("/pending/".length));
        const pending = pendingPermissions.get(id);
        if (!pending) {
          return Response.json({ success: false, error: `pending ${id} 不存在` }, { status: 404 });
        }
        // 移除 idLookup（yes_id / no_id 两条）
        for (const [lookupId, entry] of idLookup.entries()) {
          if (entry.request_id === id) idLookup.delete(lookupId);
        }
        pendingPermissions.delete(id);
        savePendingToDisk();
        log(`🧹 审批 ${id} 被手动清除 (tool=${pending.tool_name})`);
        appendAudit({
          action: "approval_manual_resolve",
          request_id: id,
          tool_name: pending.tool_name,
        });
        return Response.json({ success: true, cleaned: id, tool_name: pending.tool_name });
      }

      // ── Homeland endpoints ───────────────────────────────────────────────

      // POST /homeland/send — Dashboard 发消息（仅本机）
      if (req.method === "POST" && routePath === "/homeland/send") {
        try {
          const body = await req.json() as { content: string; instance?: string };
          if (!body.content?.trim()) {
            return Response.json({ error: "content is required" }, { status: 400 });
          }
          if (body.instance && !getInstances().has(body.instance)) {
            return Response.json({ error: `selected instance ${body.instance} is offline` }, { status: 409 });
          }
          const plugin = channelPlugins.get("homeland");
          if (!plugin) {
            return Response.json({ error: "homeland channel not loaded" }, { status: 503 });
          }
          // homeland.ts 不需要 pushMessage 自己做，这里直接走 hub 的入站路由
          // 通过 onMessage 回调会走到 hub.ts 的路由逻辑
          const { onMessage } = await import("./hub-state.js");
          const result = await onMessage({
            channel: "homeland",
            from: "Operator",
            fromId: "local://operator",
            content: body.content.trim(),
            targetInstanceId: body.instance,
            raw: {},
          });
          if (!result.accepted) {
            const failure = mapHomelandIngressFailure(result);
            return Response.json({ success: false, error: failure.error }, { status: failure.status });
          }
          return Response.json({ success: true, targets: result.targets ?? [] });
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // GET /homeland/stream — SSE 事件流
      if (req.method === "GET" && routePath === "/homeland/stream") {
        const instanceFilter = url.searchParams.get("instance") ?? undefined;
        const stream = new ReadableStream({
          start(controller) {
            const client = addSSEClient(controller, instanceFilter);
            // 发送初始连接确认
            controller.enqueue(new TextEncoder().encode("event: connected\ndata: {}\n\n"));
            // 心跳防断线
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
              } catch {
                clearInterval(heartbeat);
                removeSSEClient(client);
              }
            }, 30_000);
            // cleanup 逻辑由 client 断开触发
            req.signal.addEventListener("abort", () => {
              clearInterval(heartbeat);
              removeSSEClient(client);
            });
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            ...trustedDashboardCorsHeaders(req, url),
          },
        });
      }

      // POST /homeland/presence — Dashboard 活跃状态心跳
      if (req.method === "POST" && routePath === "/homeland/presence") {
        try {
          const body = await req.json() as { active: boolean };
          const { setDashboardPresence } = await import("./hub-state.js");
          if (setDashboardPresence) {
            setDashboardPresence(body.active ?? true);
          }
          return Response.json({ success: true });
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // ── Dashboard 审批 ──────────────────────────────────────────────────

      // POST /pending/:id/approve — 一键批准
      if (req.method === "POST" && routePath.startsWith("/pending/") && routePath.endsWith("/approve")) {
        const id = decodeURIComponent(routePath.slice("/pending/".length, -"/approve".length));
        const result = resolveApprovalFromDashboard(id, "allow");
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        return Response.json({ success: true, action: result.action });
      }

      // POST /pending/:id/deny — 一键拒绝
      if (req.method === "POST" && routePath.startsWith("/pending/") && routePath.endsWith("/deny")) {
        const id = decodeURIComponent(routePath.slice("/pending/".length, -"/deny".length));
        const result = resolveApprovalFromDashboard(id, "deny");
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        return Response.json({ success: true, action: result.action });
      }

      // POST /pending/:id/dismiss — 解除挂起（不回调 instance）
      if (req.method === "POST" && routePath.startsWith("/pending/") && routePath.endsWith("/dismiss")) {
        const id = decodeURIComponent(routePath.slice("/pending/".length, -"/dismiss".length));
        const result = dismissApprovalFromDashboard(id);
        if (!result.ok) {
          return Response.json({ error: result.error }, { status: result.status });
        }
        return Response.json({ success: true, action: result.action });
      }

      // ── GET /overview — Dashboard 首屏聚合 ─────────────────────────────

      if (req.method === "GET" && routePath === "/overview") {
        const instances = listKnownInstances();
        const health = getAllChannelHealth();
        const now = Date.now();
        const pending = [...pendingPermissions.values()].map((p) => ({
          request_id: p.request_id,
          yes_id: p.yes_id,
          no_id: p.no_id,
          tool_name: p.tool_name,
          description: p.description,
          from_instance: p.from_instance,
          waited_seconds: Math.round((now - p.created_at) / 1000),
          remaining_seconds: Math.max(0, Math.round((PERMISSION_TTL_MS - (now - p.created_at)) / 1000)),
        }));
        return Response.json({
          instances: instances.map((i) => ({
            id: i.id, tag: i.tag, description: i.description,
            isChannel: i.isChannel,
            channels: i.channels, presence: i.presence, connectedAt: i.connectedAt, lastSeenAt: i.lastSeenAt, summary: i.summary,
          })),
          channels: Object.fromEntries(
            [...channelPlugins.keys()].map(ch => {
              const h = health[ch] ?? { messagesIn: 0, messagesOut: 0, errors: 0, consecutiveFailures: 0, consecutiveSuccesses: 0 };
              return [ch, { loaded: true, ...h, health_status: deriveHealthStatus(h as any) }];
            })
          ),
          pending,
          hub: {
            version: HUB_VERSION,
            pid: process.pid,
            uptime: Math.round(process.uptime()),
            memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
            started_at: startedAt,
            locked: isLocked(),
          },
        });
      }

      // ── 静态文件 fallback（Dashboard dist/）────────────────────────────

      if (req.method === "GET") {
        const exactFile = resolveDashboardStaticFile(url.pathname);
        if (exactFile) {
          return serveDashboardFile(exactFile);
        }
        const wantsSpaShell = !path.extname(url.pathname) && !url.pathname.startsWith("/api/");
        if (wantsSpaShell) {
          const indexFile = resolveDashboardStaticFile("/");
          if (indexFile) return serveDashboardFile(indexFile);
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  log(`HTTP server 启动: ${config.host}:${config.port}`);
}
