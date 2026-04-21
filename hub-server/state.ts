/**
 * Forge Hub — 分通道状态管理
 *
 * 每个通道一个子目录：~/.forge-hub/state/<channel>/
 * 每个状态一个 JSON 文件。
 */

import fs from "node:fs";
import path from "node:path";

import { STATE_DIR, logError } from "./config.js";
import type { Allowlist } from "./types.js";

export function loadChannelState(channel: string, key: string): unknown {
  const filePath = path.join(STATE_DIR, channel, `${key}.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    logError(`读取状态 ${channel}/${key} 失败: ${String(err)}`);
  }
  return null;
}

export function saveChannelState(channel: string, key: string, value: unknown): void {
  const dir = path.join(STATE_DIR, channel);
  const filePath = path.join(dir, `${key}.json`);
  const tmp = `${filePath}.tmp.${process.pid}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* ignore */ }
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
  return loadAllowlist(channel).allowed.some((e) => e.id === senderId);
}

/** 查 allowlist 里某 id 对应的 nickname，不存在则 fallback 返回 id 本身 */
export function getNickname(channel: string, senderId: string): string {
  return loadAllowlist(channel).allowed.find((e) => e.id === senderId)?.nickname ?? senderId;
}
