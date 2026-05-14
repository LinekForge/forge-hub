import {
  HUB_NAME, HUB_VERSION, isLocked, getLockState,
  deriveHealthStatus, getAllChannelHealth,
} from "../config.js";
import { listKnownInstances } from "../instance-manager.js";
import { channelPlugins } from "../channel-registry.js";
import { startedAt } from "../hub-state.js";
import { pendingPermissions, PERMISSION_TTL_MS } from "../approval.js";
import { readRecentHistory } from "../history.js";
import { getPlugin } from "../channel-loader.js";

export function handleHealth(): Response {
  return Response.json({
    ok: true, name: HUB_NAME, version: HUB_VERSION,
    uptime: Math.round(process.uptime()), locked: isLocked(),
  });
}

function buildChannelHealth() {
  const health = getAllChannelHealth();
  return Object.fromEntries(
    [...channelPlugins.keys()].map(ch => {
      const h = health[ch] ?? { messagesIn: 0, messagesOut: 0, errors: 0, consecutiveFailures: 0, consecutiveSuccesses: 0 };
      const stoppedReason = getPlugin(ch)?.stoppedReason;
      return [ch, {
        loaded: true,
        ...h,
        health_status: deriveHealthStatus(h as any),
        ...(stoppedReason ? { stoppedReason } : {}),
      }];
    })
  );
}

export function buildInstanceList(includeSummary = false) {
  return listKnownInstances().map((i) => ({
    id: i.id, tag: i.tag, description: i.description, isChannel: i.isChannel,
    channels: i.channels, presence: i.presence, connectedAt: i.connectedAt, lastSeenAt: i.lastSeenAt,
    ...(includeSummary ? { summary: i.summary } : {}),
  }));
}

function buildPendingList() {
  const now = Date.now();
  return [...pendingPermissions.values()].map((p) => ({
    request_id: p.request_id, yes_id: p.yes_id, no_id: p.no_id,
    tool_name: p.tool_name, description: p.description, from_instance: p.from_instance,
    waited_seconds: Math.round((now - p.created_at) / 1000),
    remaining_seconds: Math.max(0, Math.round((PERMISSION_TTL_MS - (now - p.created_at)) / 1000)),
  }));
}

function buildHubInfo() {
  return {
    version: HUB_VERSION, pid: process.pid,
    uptime: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    started_at: startedAt, locked: isLocked(),
  };
}

export function handleStatus(): Response {
  return Response.json({
    hub: { ...buildHubInfo(), lock: getLockState() },
    channels: buildChannelHealth(),
    instances: buildInstanceList(),
  });
}

export function handlePending(): Response {
  const pending = buildPendingList();
  return Response.json({ count: pending.length, pending });
}

export function handleOverview(): Response {
  return Response.json({
    hub: buildHubInfo(),
    channels: buildChannelHealth(),
    instances: buildInstanceList(true),
    pending: buildPendingList(),
  });
}

export async function handleHistory(url: URL): Promise<Response> {
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
