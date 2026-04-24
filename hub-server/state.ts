/**
 * Forge Hub — 分通道状态管理
 *
 * 每个通道一个子目录：~/.forge-hub/state/<channel>/
 * 每个状态一个 JSON 文件。
 */

import fs from "node:fs";
import path from "node:path";

import { getStateDir, logError } from "./config.js";
import type { AllowEntry, Allowlist } from "./types.js";
import { isAuthorizedSenderMatch } from "./message-auth.js";

type CachedState = { value: unknown };
type StateReadResult =
  | { status: "ok"; value: unknown }
  | { status: "missing"; filePath: string }
  | { status: "error"; filePath: string; error: string };

const stateCache = new Map<string, CachedState>();
const channelWatchers = new Map<string, fs.FSWatcher>();

function cacheKey(channel: string, key: string): string {
  return `${channel}\x00${key}`;
}

function cloneState<T>(value: T): T {
  return structuredClone(value);
}

function invalidateChannelState(channel: string, key?: string): void {
  if (key) {
    stateCache.delete(cacheKey(channel, key));
    return;
  }
  for (const cacheId of stateCache.keys()) {
    if (cacheId.startsWith(`${channel}\x00`)) stateCache.delete(cacheId);
  }
}

function ensureChannelWatcher(channel: string): boolean {
  if (channelWatchers.has(channel)) return true;

  const dir = path.join(getStateDir(), channel);
  if (!fs.existsSync(dir)) return false;

  try {
    const watcher = fs.watch(dir, (_eventType, filename) => {
      if (!filename) {
        invalidateChannelState(channel);
        return;
      }
      const name = String(filename);
      if (!name.endsWith(".json")) return;
      invalidateChannelState(channel, path.basename(name, ".json"));
    });
    watcher.on("error", (err) => {
      channelWatchers.delete(channel);
      invalidateChannelState(channel);
      logError(`状态 watch 失效 (${channel}): ${String(err)}`);
    });
    watcher.unref?.();
    channelWatchers.set(channel, watcher);
    return true;
  } catch (err) {
    logError(`状态 watch 启动失败 (${channel}): ${String(err)}`);
    return false;
  }
}

function readChannelStateInternal(channel: string, key: string): StateReadResult {
  const cached = stateCache.get(cacheKey(channel, key));
  if (cached) return { status: "ok", value: cloneState(cached.value) };

  const filePath = path.join(getStateDir(), channel, `${key}.json`);
  try {
    if (!fs.existsSync(filePath)) return { status: "missing", filePath };

    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (ensureChannelWatcher(channel)) {
      stateCache.set(cacheKey(channel, key), { value });
    }
    return { status: "ok", value: cloneState(value) };
  } catch (err) {
    return { status: "error", filePath, error: String(err) };
  }
}

export function loadChannelState(channel: string, key: string): unknown {
  const result = readChannelStateInternal(channel, key);
  if (result.status === "ok") return result.value;
  if (result.status === "error") {
    logError(`读取状态 ${channel}/${key} 失败: ${result.error}`);
  }
  return null;
}

export function saveChannelState(channel: string, key: string, value: unknown): void {
  const dir = path.join(getStateDir(), channel);
  const filePath = path.join(dir, `${key}.json`);
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
    if (ensureChannelWatcher(channel)) {
      stateCache.set(cacheKey(channel, key), { value: cloneState(value) });
    } else {
      stateCache.delete(cacheKey(channel, key));
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    logError(`写入状态 ${channel}/${key} 失败: ${String(err)}`);
  }
}

// ── Allowlist helpers（4 通道共享的 DRY 抽取）──────────────────────────────
// 之前每个通道自己写 `(hub.getState("allowlist") ?? {...}) as Allowlist`——schema 分散风险。
// 抽到这里：统一 schema（types.ts::Allowlist）+ 统一 fallback + 统一 sender 比对逻辑。

export function loadAllowlist(channel: string): Allowlist {
  return (loadChannelState(channel, "allowlist") ?? { allowed: [], auto_allow_next: false }) as Allowlist;
}

/** sender id 是否在 allowlist。4 通道使用时保持一致的严格 string 匹配——imessage 对 caseLower 有需求可自行 lowercase 后调 */
export function isAllowedSender(channel: string, senderId: string): boolean {
  return loadAllowlist(channel).allowed.some((e) => isAuthorizedSenderMatch(channel, senderId, e.id));
}

/** 查 allowlist 里某 id 对应的 nickname，不存在则 fallback 返回 id 本身 */
export function getNickname(channel: string, senderId: string): string {
  return findAllowlistEntry(channel, senderId)?.nickname ?? senderId;
}

export type AllowlistReadResult =
  | { ok: true; allowlist: Allowlist }
  | { ok: false; error: string };

export function readAllowlist(channel: string): AllowlistReadResult {
  const result = readChannelStateInternal(channel, "allowlist");
  if (result.status === "ok") {
    return { ok: true, allowlist: result.value as Allowlist };
  }
  if (result.status === "missing") {
    return { ok: false, error: `allowlist not found: ${result.filePath}` };
  }
  return { ok: false, error: `${result.error} (path=${result.filePath})` };
}

export function findAllowlistEntry(channel: string, senderId: string): AllowEntry | undefined {
  return loadAllowlist(channel).allowed.find((entry) => isAuthorizedSenderMatch(channel, senderId, entry.id));
}

export function getPrimaryAllowlistEntry(channel: string): AllowEntry | undefined {
  return loadAllowlist(channel).allowed[0];
}
