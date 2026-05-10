/**
 * Forge Hub — HTTP + WebSocket entry point
 *
 * Thin dispatcher: auth → route → handler. Business logic lives in routes/*.
 */

import type { HubConfig, WsData } from "./types.js";
import { log, isLocked, readAuthToken, redactSensitive } from "./config.js";
import { handleWsOpen, handleWsMessage, handleWsClose } from "./instance-manager.js";
import { triggerLock, triggerUnlock } from "./lock.js";

import { handleHealth, handleStatus, handlePending, handleOverview } from "./routes/health.js";
import { handleSend, handleSendFile, handleSendVoice } from "./routes/send.js";
import { handlePermissionRequest, handleDeletePending, handleDashboardApprove, handleDashboardDeny, handleDashboardDismiss } from "./routes/approval.js";
import { handleInstances, handleChannels, handleSetTag, handleSetDescription, handleSetChannels, handleSetSummary } from "./routes/instances.js";
import { handleHomelandSend, handleHomelandStream, handleHomelandPresence } from "./routes/homeland.js";
import {
  hasDashboardSession, shouldRejectUntrustedBrowserOrigin, trustedDashboardCorsHeaders,
  isDashboardStaticRequest, serveDashboardStaticOrSpa,
  handleDashboardAuth, handleDashboardLogout,
} from "./routes/dashboard.js";
import { readRecentHistory } from "./history.js";
import { channelPlugins } from "./channel-registry.js";

function normalizeApiPath(pathname: string): string {
  if (pathname === "/api" || pathname === "/api/") return "/";
  if (pathname.startsWith("/api/")) return pathname.slice(4);
  return pathname;
}

export function startServer(config: HubConfig): void {
  Bun.serve<WsData>({
    port: config.port,
    hostname: config.host,
    idleTimeout: 0,

    websocket: {
      open(ws) { handleWsOpen(ws); },
      message(ws, msg) { handleWsMessage(ws, msg); },
      close(ws) { handleWsClose(ws); },
      sendPings: true,
    },

    async fetch(req, server) {
      const url = new URL(req.url);
      const routePath = normalizeApiPath(url.pathname);

      // ── Auth ────────────────────────────────────────────────────────────
      const apiToken = readAuthToken();
      const isWsUpgrade = req.method === "GET" && routePath === "/ws";
      const isPublicHealthCheck = req.method === "GET" && routePath === "/health";
      const isDashboardStatic = isDashboardStaticRequest(req, url);
      const isDashboardAuthReq = req.method === "POST" && routePath === "/dashboard-auth";
      const isDashboardLogoutReq = req.method === "POST" && routePath === "/dashboard-logout";
      const hasDashboardCookie = hasDashboardSession(req, apiToken);

      if (shouldRejectUntrustedBrowserOrigin(req, url, routePath, isWsUpgrade)) {
        return Response.json({ error: "forbidden_origin" }, { status: 403 });
      }

      if (apiToken && !isPublicHealthCheck && !isDashboardStatic && !isDashboardAuthReq && !isDashboardLogoutReq) {
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
        if (!hasBearerToken && hasDashboardCookie) {
          const requiresCheck = isWsUpgrade ||
            (req.method === "GET" && routePath === "/homeland/stream") ||
            ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
          const origin = req.headers.get("Origin");
          if (requiresCheck && origin) {
            const { trustedDashboardOrigins } = await import("./routes/dashboard.js");
            if (!trustedDashboardOrigins(url).has(origin)) {
              return Response.json({ error: "forbidden_origin" }, { status: 403 });
            }
          }
        }
      }

      // ── Routes ──────────────────────────────────────────────────────────
      try {
        // WebSocket
        if (isWsUpgrade) {
          const instanceId = url.searchParams.get("instance");
          if (!instanceId) return new Response("missing instance parameter", { status: 400 });
          const ok = server.upgrade(req, { data: { instanceId } });
          if (ok) return undefined as unknown as Response;
          return new Response("WebSocket upgrade failed", { status: 500 });
        }

        // Health / Status
        if (req.method === "GET" && routePath === "/health") return handleHealth();
        if (req.method === "GET" && routePath === "/status") return handleStatus();
        if (req.method === "GET" && routePath === "/overview") return handleOverview();
        if (req.method === "GET" && routePath === "/pending") return handlePending();

        // Dashboard auth
        if (isDashboardAuthReq) return await handleDashboardAuth(req, apiToken);
        if (isDashboardLogoutReq) return handleDashboardLogout();

        // Instances
        if (req.method === "GET" && routePath === "/instances") return handleInstances();
        if (req.method === "GET" && routePath === "/channels") return handleChannels();
        if (req.method === "POST" && (routePath === "/set-tag" || routePath === "/set-name")) return await handleSetTag(req);
        if (req.method === "POST" && routePath === "/set-description") return await handleSetDescription(req);
        if (req.method === "POST" && routePath === "/set-channels") return await handleSetChannels(req);
        if (req.method === "POST" && routePath === "/set-summary") return await handleSetSummary(req);

        // Lock
        if (req.method === "POST" && routePath === "/lock") {
          if (!isLocked()) triggerLock("cli");
          return Response.json({ success: true, locked: true });
        }
        if (req.method === "POST" && routePath === "/unlock") {
          if (isLocked()) triggerUnlock();
          return Response.json({ success: true, locked: false });
        }

        // Lock guard for send endpoints
        if (isLocked() && req.method === "POST" && (routePath === "/send" || routePath === "/send-file" || routePath === "/send-voice")) {
          try {
            const body = await req.json() as { channel?: string; text?: string; instance?: string; path?: string };
            const who = body.instance ?? "unknown";
            const what = body.text?.slice(0, 60) ?? body.path?.split("/").pop() ?? "";
            log(`🔒 出站拦截 [${body.channel ?? "?"}] ${who}: ${what} [已锁定]`);
          } catch {}
          return Response.json({ success: false, error: "Hub 已锁定" });
        }

        // Send
        if (req.method === "POST" && routePath === "/send") return await handleSend(req);
        if (req.method === "POST" && routePath === "/send-file") return await handleSendFile(req);
        if (req.method === "POST" && routePath === "/send-voice") return await handleSendVoice(req);

        // Approval
        if (req.method === "POST" && routePath === "/permission-request") return await handlePermissionRequest(req);
        if (req.method === "DELETE" && routePath.startsWith("/pending/")) return handleDeletePending(routePath);
        if (req.method === "POST" && routePath.startsWith("/pending/") && routePath.endsWith("/approve")) return handleDashboardApprove(routePath);
        if (req.method === "POST" && routePath.startsWith("/pending/") && routePath.endsWith("/deny")) return handleDashboardDeny(routePath);
        if (req.method === "POST" && routePath.startsWith("/pending/") && routePath.endsWith("/dismiss")) return handleDashboardDismiss(routePath);

        // History
        if (req.method === "GET" && routePath === "/history") {
          const channel = url.searchParams.get("channel") ?? "wechat";
          if (!channelPlugins.has(channel)) {
            return Response.json({ error: `unknown channel: ${channel}` }, { status: 400 });
          }
          let limit = parseInt(url.searchParams.get("limit") ?? "200", 10);
          if (!Number.isFinite(limit) || limit <= 0 || limit > 1000) limit = 200;
          const sinceTs = url.searchParams.get("since_ts");
          const recent = await readRecentHistory(channel, limit, sinceTs ?? undefined);
          return Response.json({ channel, history: recent });
        }

        // Homeland
        if (req.method === "POST" && routePath === "/homeland/send") return await handleHomelandSend(req);
        if (req.method === "GET" && routePath === "/homeland/stream") return handleHomelandStream(req, url, trustedDashboardCorsHeaders(req, url));
        if (req.method === "POST" && routePath === "/homeland/presence") return await handleHomelandPresence(req);

        // Dashboard static files (fallback)
        if (req.method === "GET") {
          const staticResponse = serveDashboardStaticOrSpa(url);
          if (staticResponse) return staticResponse;
        }

        return new Response("not found", { status: 404 });
      } catch (err) {
        return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
      }
    },
  });

  log(`HTTP server 启动: ${config.host}:${config.port}`);
}
