/**
 * Forge Hub — 实例连接管理
 *
 * 管理 hub-client 的 WebSocket 连接。
 */

import type { ServerWebSocket } from "bun";
import { log } from "./config.js";
import { loadChannelState, saveChannelState } from "./state.js";
import type { ConnectedInstance, HubEvent, WsData, WsClientMessage } from "./types.js";

// ── Name Persistence ────────────────────────────────────────────────────────

interface SavedIdentity { tag?: string; description?: string; channels?: string[]; isChannel?: boolean }

function loadSavedIdentities(): Record<string, SavedIdentity> {
  return (loadChannelState("_hub", "instance-identities") ?? {}) as Record<string, SavedIdentity>;
}

function saveIdentity(instanceId: string, identity: SavedIdentity): void {
  const all = loadSavedIdentities();
  all[instanceId] = { ...all[instanceId], ...identity };
  saveChannelState("_hub", "instance-identities", all);
}

// ── Connected Instances ─────────────────────────────────────────────────────

const instances = new Map<string, ConnectedInstance>();

export function getInstances(): Map<string, ConnectedInstance> {
  return instances;
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
    connectedAt: new Date().toISOString(),
    ws,
    send(event: HubEvent) {
      try { ws.send(JSON.stringify(event)); } catch (err) { log(`⚠ WebSocket send 失败 (${instanceId}): ${String(err)}`); }
    },
    close() {
      try { ws.close(); } catch {}
    },
  };

  // Restore saved identity
  const saved = loadSavedIdentities()[instanceId];
  if (saved?.tag) instance.tag = saved.tag;
  if (saved?.description) instance.description = saved.description;
  if (saved?.channels) instance.channels = saved.channels;

  instances.set(instanceId, instance);
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

export function setInstanceTag(instanceId: string, tag: string): boolean {
  if (typeof tag !== "string" || tag.length > MAX_TAG_LENGTH) {
    log(`⚠ setInstanceTag 拒绝: ${instanceId} tag 非 string 或超过 ${MAX_TAG_LENGTH} 字符`);
    return false;
  }
  const instance = instances.get(instanceId);
  if (instance) {
    instance.tag = tag;
  }
  // Always persist — works for both online and offline instances
  saveIdentity(instanceId, { tag });
  log(`📛 标签: ${instanceId} → @${tag}`);
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
