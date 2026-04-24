/**
 * Forge Hub — 实例连接管理
 *
 * 管理 hub-client 的 WebSocket 连接。
 */

import type { ServerWebSocket } from "bun";
import { log } from "./config.js";
import { loadChannelState, saveChannelState } from "./state.js";
import type { ConnectedInstance, HubEvent, KnownInstance, WsData, WsClientMessage } from "./types.js";

// ── Name Persistence ────────────────────────────────────────────────────────

interface SavedIdentity {
  tag?: string;
  description?: string;
  channels?: string[];
  isChannel?: boolean;
  lastSeenAt?: string;
}

// instanceId 绑定 Claude Code 父进程 pid，天然是会轮换的“会话级 identity”。
// 保留 24h 足够覆盖断线重连 / 短期排障，同时避免 roster 永久堆积 ghost。
const KNOWN_IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;

function loadSavedIdentities(): Record<string, SavedIdentity> {
  return (loadChannelState("_hub", "instance-identities") ?? {}) as Record<string, SavedIdentity>;
}

function persistSavedIdentities(all: Record<string, SavedIdentity>): void {
  saveChannelState("_hub", "instance-identities", all);
}

function parseSeenAt(value: string | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function pruneSavedIdentities(all: Record<string, SavedIdentity>): { identities: Record<string, SavedIdentity>; changed: boolean } {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const next: Record<string, SavedIdentity> = {};
  let changed = false;

  for (const [id, rawIdentity] of Object.entries(all)) {
    const identity = { ...rawIdentity };
    const seenAt = parseSeenAt(identity.lastSeenAt);

    if (identity.isChannel === false) {
      if (seenAt === null || now - seenAt > KNOWN_IDENTITY_TTL_MS) {
        changed = true;
        continue;
      }
      next[id] = identity;
      continue;
    }

    if (seenAt === null) {
      identity.lastSeenAt = nowIso;
      changed = true;
      next[id] = identity;
      continue;
    }

    if (now - seenAt > KNOWN_IDENTITY_TTL_MS) {
      changed = true;
      continue;
    }

    next[id] = identity;
  }

  return { identities: next, changed };
}

function getSavedIdentities(): Record<string, SavedIdentity> {
  const pruned = pruneSavedIdentities(loadSavedIdentities());
  if (pruned.changed) persistSavedIdentities(pruned.identities);
  return pruned.identities;
}

function saveIdentity(instanceId: string, identity: SavedIdentity): void {
  const all = getSavedIdentities();
  all[instanceId] = {
    ...all[instanceId],
    ...identity,
    lastSeenAt: identity.lastSeenAt ?? new Date().toISOString(),
  };
  persistSavedIdentities(all);
}

// ── Connected Instances ─────────────────────────────────────────────────────

const instances = new Map<string, ConnectedInstance>();

export function getInstances(): Map<string, ConnectedInstance> {
  return instances;
}

function rankKnownInstance(instance: KnownInstance): number {
  if (instance.presence === "live") return 0;
  if (instance.isChannel !== false) return 1;
  return 2;
}

function displayName(instance: KnownInstance): string {
  return instance.description ?? instance.tag ?? instance.id;
}

export function listKnownInstances(): KnownInstance[] {
  const saved = getSavedIdentities();
  const ids = new Set<string>([...Object.keys(saved), ...instances.keys()]);

  return [...ids]
    .map((id) => {
      const live = instances.get(id);
      const persisted = saved[id];
      return {
        id,
        tag: live?.tag ?? persisted?.tag,
        description: live?.description ?? persisted?.description,
        isChannel: live?.isChannel ?? persisted?.isChannel ?? false,
        channels: live?.channels ?? persisted?.channels,
        presence: live ? "live" : "known",
        connectedAt: live?.connectedAt,
        lastSeenAt: live?.connectedAt ?? persisted?.lastSeenAt,
        summary: live?.summary,
      } satisfies KnownInstance;
    })
    .sort((a, b) => {
      const rankDiff = rankKnownInstance(a) - rankKnownInstance(b);
      if (rankDiff !== 0) return rankDiff;
      return displayName(a).localeCompare(displayName(b), "zh-CN");
    });
}

// ── onReady Callback ────────────────────────────────────────────────────────

type OnReadyCallback = (instanceId: string, history?: Record<string, number>) => void;
let onReadyCallback: OnReadyCallback | null = null;

export function setOnReadyCallback(cb: OnReadyCallback): void {
  onReadyCallback = cb;
}

// ── WebSocket Handlers ──────────────────────────────────────────────────────

export function handleWsOpen(ws: ServerWebSocket<WsData>): void {
  const instanceId = ws.data.instanceId;

  // Close existing connection for same instance (reconnect)
  const existing = instances.get(instanceId);
  if (existing) {
    existing.close();
    instances.delete(instanceId);
    log(`🔄 实例重连: ${instanceId}`);
  }

  const instance: ConnectedInstance = {
    id: instanceId,
    isChannel: true,
    connectedAt: new Date().toISOString(),
    ws,
    send(event: HubEvent) {
      try {
        return ws.send(JSON.stringify(event));
      } catch (err) {
        log(`⚠ WebSocket send 失败 (${instanceId}): ${String(err)}`);
        return 0;
      }
    },
    close() {
      try { ws.close(); } catch {}
    },
  };

  // Restore saved identity
  const saved = loadSavedIdentities()[instanceId];
  if (saved?.description) instance.description = saved.description;
  if (saved?.channels) instance.channels = saved.channels;

  instances.set(instanceId, instance);
  if (saved?.tag && !setInstanceTag(instanceId, saved.tag)) {
    saveIdentity(instanceId, { tag: undefined });
    log(`⚠ 恢复标签失败: ${instanceId} 的历史 tag @${saved.tag} 与现有实例冲突，已清除`);
  }
  saveIdentity(instanceId, {
    tag: instance.tag,
    description: instance.description,
    channels: instance.channels,
    isChannel: true,
    lastSeenAt: instance.connectedAt,
  });
  const tagInfo = instance.tag ? ` @${instance.tag}` : "";
  const descInfo = instance.description ? ` (${instance.description})` : "";
  log(`🔌 实例连接: ${instanceId}${descInfo}${tagInfo} (在线 ${instances.size})`);

  // Send connection confirmation
  ws.send(JSON.stringify({ type: "connected" }));
}

export function handleWsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
  const instanceId = ws.data.instanceId;
  try {
    const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as WsClientMessage;

    if (msg.type === "ready") {
      // Only apply ready values if Hub doesn't already have a saved value
      // (user may have renamed via menubar — don't overwrite)
      const saved = loadSavedIdentities()[instanceId];
      if (msg.tag && !saved?.tag) setInstanceTag(instanceId, msg.tag);
      if (msg.description && !saved?.description) setInstanceDescription(instanceId, msg.description);
      if (msg.channels) {
        const channels = msg.channels.includes("all") ? undefined : msg.channels;
        setInstanceChannels(instanceId, channels);
      }
      // Delegate history + context push to hub.ts, pass history config
      onReadyCallback?.(instanceId, msg.history);
    }
  } catch (err) {
    log(`⚠ WebSocket 消息解析失败 (${instanceId}): ${String(err)}`);
  }
}

export function handleWsClose(ws: ServerWebSocket<WsData>): void {
  const instanceId = ws.data.instanceId;
  const instance = instances.get(instanceId);
  if (!instance || instance.ws !== ws) return;
  saveIdentity(instanceId, {
    tag: instance.tag,
    description: instance.description,
    channels: instance.channels,
    isChannel: instance.isChannel ?? true,
    lastSeenAt: new Date().toISOString(),
  });
  instances.delete(instanceId);
  log(`🔌 实例断开: ${instanceId} (在线 ${instances.size})`);
}

// ── Push to Instances ───────────────────────────────────────────────────────

export function pushToInstances(targetIds: string[], event: HubEvent): void {
  for (const id of targetIds) {
    const instance = instances.get(id);
    if (instance) {
      instance.send(event);
    }
  }
}

// ── Update Summary ──────────────────────────────────────────────────────────

export function setSummary(instanceId: string, summary: string): boolean {
  if (typeof summary !== "string" || summary.length > MAX_SUMMARY_LENGTH) {
    log(`⚠ setSummary 拒绝: ${instanceId} summary 非 string 或超过 ${MAX_SUMMARY_LENGTH} 字符`);
    return false;
  }
  const instance = instances.get(instanceId);
  if (instance) {
    instance.summary = summary;
    return true;
  }
  return false;
}

// ── Set Tag ─────────────────────────────────────────────────────────────────

// redteam r2 L7: tag / description 进入 router @mention 匹配表（每条消息 O(n×m)
// 扫描），无长度上限让 rogue instance 可设 1MB tag 做 CPU DoS。且防御不该依赖
// caller——type/length 校验放最底层最稳。
const MAX_TAG_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 256;

function findTagConflict(instanceId: string, tag: string): string | null {
  for (const [otherId, instance] of instances) {
    if (otherId === instanceId) continue;
    if (instance.tag === tag) return otherId;
  }

  const saved = getSavedIdentities();
  for (const [otherId, identity] of Object.entries(saved)) {
    if (otherId === instanceId) continue;
    if (identity.tag === tag) return otherId;
  }

  return null;
}

export function setInstanceTag(instanceId: string, tag: string): boolean {
  if (typeof tag !== "string") {
    log(`⚠ setInstanceTag 拒绝: ${instanceId} tag 不是 string`);
    return false;
  }
  const normalizedTag = tag.trim();
  if (normalizedTag.length > MAX_TAG_LENGTH) {
    log(`⚠ setInstanceTag 拒绝: ${instanceId} tag 非 string 或超过 ${MAX_TAG_LENGTH} 字符`);
    return false;
  }
  if (!normalizedTag) {
    const instance = instances.get(instanceId);
    if (instance) delete instance.tag;
    saveIdentity(instanceId, { tag: undefined });
    log(`📛 标签清除: ${instanceId}`);
    return true;
  }
  const conflictId = findTagConflict(instanceId, normalizedTag);
  if (conflictId) {
    log(`⚠ setInstanceTag 拒绝: ${instanceId} tag @${normalizedTag} 与 ${conflictId} 冲突`);
    return false;
  }
  const instance = instances.get(instanceId);
  if (instance) {
    instance.tag = normalizedTag;
  }
  // Always persist — works for both online and offline instances
  saveIdentity(instanceId, { tag: normalizedTag });
  log(`📛 标签: ${instanceId} → @${normalizedTag}`);
  return true;
}

// ── Set Description ─────────────────────────────────────────────────────────

export function setInstanceDescription(instanceId: string, description: string): boolean {
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
    log(`⚠ setInstanceDescription 拒绝: ${instanceId} description 非 string 或超过 ${MAX_DESCRIPTION_LENGTH} 字符`);
    return false;
  }
  const instance = instances.get(instanceId);
  if (instance) {
    instance.description = description;
  }
  // Always persist — works for both online and offline instances
  saveIdentity(instanceId, { description });
  log(`📝 描述: ${instanceId} → ${description}`);
  return true;
}

// ── Set Channels ───────────────────────────────────────────────────────────

export function setInstanceChannels(instanceId: string, channels: string[] | undefined): boolean {
  const instance = instances.get(instanceId);
  if (instance) {
    instance.channels = channels;
    saveIdentity(instanceId, { channels, isChannel: true });
    const label = channels ? channels.join(", ") : "all";
    log(`📡 通道订阅: ${instanceId} → [${label}]`);
    return true;
  }
  return false;
}

// ── Find by Name ────────────────────────────────────────────────────────────

export function findByTag(tag: string): ConnectedInstance | undefined {
  for (const instance of instances.values()) {
    if (instance.tag === tag) return instance;
  }
  return undefined;
}
