/**
 * Forge Hub — HTTP + WebSocket endpoints
 *
 * 所有 HTTP endpoints 和 WebSocket upgrade 都在这里。依赖全部通过 import
 * 拿到——hub.ts main() 负责填 state（populate registry, loadPendingFromDisk,
 * setCurrentConfig）再 startServer，所以本模块不碰初始化，只负责 serve。
 */

import fs from "node:fs";
import path from "node:path";

import type { HubConfig, WsData } from "./types.js";
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
} from "./approval.js";
import { triggerLock, triggerUnlock } from "./lock.js";
import { checkPermissionRate, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS } from "./rate-limit.js";
import { resolveRecipient } from "./resolve.js";
import { appendHistory, getOutboundFrom, readRecentHistory } from "./history.js";
import { synthesizeToOgg } from "./tts.js";
import { getCurrentConfig, startedAt } from "./hub-state.js";

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

      // ── 可选 API Token 鉴权 ──────────────────────────────────────────────
      // 开源场景：本机多用户 / Hub bind 到 0.0.0.0 时，任何本机/网络进程都能 POST 消息。
      // 设置 HUB_API_TOKEN env 启用验证——所有非豁免的请求必须带
      // `Authorization: Bearer <token>`。default 不验（保持用户本机 localhost-only 的当前行为）。
      //
      // 豁免清单（严格）：
      //   - GET /status：健康检查入口，让监控工具能打
      //
      // WebSocket /ws：token 通过 query param `?token=` 传递（WebSocket 标准不允许
      // browser 改 header；Bun-side 保持 query-param 便于跨实现兼容）。之前 /ws 豁免
      // 导致任何本机/网络进程可伪造 instance ID 接管现有连接并劫持通道消息——redteam B1。
      //
      // 其他所有 GET（如 /pending、/instances、/channels、/history）**都必须带 token**——
      // 它们暴露 pending 审批的 yes_id/no_id、实例列表、聊天历史等敏感数据。
      const apiToken = readAuthToken();
      const isWsUpgrade = req.method === "GET" && url.pathname === "/ws";
      const isStatusCheck = req.method === "GET" && url.pathname === "/status";
      if (apiToken && !isStatusCheck) {
        let providedToken = "";
        if (isWsUpgrade) {
          providedToken = url.searchParams.get("token") ?? "";
        } else {
          const authHeader = req.headers.get("Authorization") ?? "";
          providedToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        }
        if (providedToken !== apiToken) {
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
      }

      // GET /ws — WebSocket 实例连接
      if (req.method === "GET" && url.pathname === "/ws") {
        const instanceId = url.searchParams.get("instance");
        if (!instanceId) {
          return new Response("missing instance parameter", { status: 400 });
        }
        const ok = server.upgrade(req, { data: { instanceId } });
        if (ok) return undefined as unknown as Response;
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // GET /status
      if (req.method === "GET" && url.pathname === "/status") {
        const instances = getInstances();
        return Response.json({
          name: HUB_NAME,
          version: HUB_VERSION,
          uptime: process.uptime(),
          locked: isLocked(),
          instances: [...instances.keys()],
          channels: [...channelPlugins.keys()],
        });
      }

      // GET /health — detailed health for debugging
      if (req.method === "GET" && url.pathname === "/health") {
        const instances = getInstances();
        const health = getAllChannelHealth();
        const mem = process.memoryUsage();
        return Response.json({
          hub: {
            version: HUB_VERSION,
            pid: process.pid,
            uptime: Math.round(process.uptime()),
            memory_mb: Math.round(mem.rss / 1024 / 1024),
            started_at: startedAt,
            lock: getLockState(),
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
          instances: [...instances.values()].map(i => ({
            id: i.id,
            tag: i.tag,
            description: i.description,
            channels: i.channels,
            connectedAt: i.connectedAt,
          })),
        });
      }

      // GET /pending — 列出当前挂起的审批（用户可观测性）
      if (req.method === "GET" && url.pathname === "/pending") {
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
      if (req.method === "GET" && url.pathname === "/instances") {
        const instances = getInstances();
        const list = [...instances.values()].map((i) => ({
          id: i.id,
          tag: i.tag,
          description: i.description,
          channels: i.channels,
          connectedAt: i.connectedAt,
          summary: i.summary,
        }));
        return Response.json({ instances: list });
      }

      // GET /channels
      if (req.method === "GET" && url.pathname === "/channels") {
        const meta = [...channelPluginsMeta.values()].map(p => ({
          id: p.name, name: p.displayName, aliases: p.aliases,
        }));
        return Response.json({ channels: meta });
      }

      // POST /lock
      if (req.method === "POST" && url.pathname === "/lock") {
        if (!isLocked()) {
          triggerLock("cli");
        }
        return Response.json({ success: true, locked: true });
      }

      // POST /unlock
      if (req.method === "POST" && url.pathname === "/unlock") {
        if (isLocked()) {
          triggerUnlock();
        }
        return Response.json({ success: true, locked: false });
      }

      // ── Lock guard for all outbound endpoints ────────────────────────────
      if (isLocked() && req.method === "POST" && (url.pathname === "/send" || url.pathname === "/send-file" || url.pathname === "/send-voice")) {
        try {
          const body = await req.json() as { channel?: string; text?: string; instance?: string; path?: string };
          const who = body.instance ?? "unknown";
          const what = body.text?.slice(0, 60) ?? body.path?.split("/").pop() ?? "";
          log(`🔒 出站拦截 [${body.channel ?? "?"}] ${who}: ${what} [已锁定]`);
        } catch {}
        return Response.json({ success: false, error: "Hub 已锁定" });
      }

      // POST /permission-request — 实例发起远程审批请求
      if (req.method === "POST" && url.pathname === "/permission-request") {
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
      if (req.method === "POST" && url.pathname === "/send") {
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

          const result = await plugin.send({
            to,
            content: taggedText,
            type: "text",
            raw: { context_token: contextToken },
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
      if (req.method === "POST" && url.pathname === "/send-file") {
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
      if (req.method === "POST" && url.pathname === "/send-voice") {
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
      if (req.method === "GET" && url.pathname === "/history") {
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
      if (req.method === "POST" && (url.pathname === "/set-tag" || url.pathname === "/set-name")) {
        try {
          const body = await req.json() as { instance: string; tag?: string; name?: string };
          const ok = setInstanceTag(body.instance, body.tag ?? body.name ?? "");
          return Response.json({ success: ok });
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // POST /set-description
      if (req.method === "POST" && url.pathname === "/set-description") {
        try {
          const body = await req.json() as { instance: string; description: string };
          const ok = setInstanceDescription(body.instance, body.description);
          return Response.json({ success: ok });
        } catch (err) {
          return Response.json({ error: redactSensitive(String(err)) }, { status: 500 });
        }
      }

      // POST /set-channels
      if (req.method === "POST" && url.pathname === "/set-channels") {
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
      if (req.method === "POST" && url.pathname === "/set-summary") {
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
      if (req.method === "DELETE" && url.pathname.startsWith("/pending/")) {
        const id = decodeURIComponent(url.pathname.slice("/pending/".length));
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

      return new Response("not found", { status: 404 });
    },
  });

  log(`HTTP server 启动: ${config.host}:${config.port}`);
}
