/**
 * Forge Hub — Panic lock (紧急锁定)
 *
 * 用户触发的安全功能：锁定后 hub 关闭所有远程通道入站转发 + 拦截出站。
 * 触发方式：
 *   - 通道消息内容**完全等于** lock-phrase（panic button）→ 自动触发
 *   - CLI: fh hub lock / unlock（unlock 需 Touch ID，见 forge.ts）
 *
 * lock-phrase 存在 ~/.forge-hub/lock-phrase.json。文件不存在或暗号空 = panic
 * 功能 disabled（不影响 CLI lock/unlock）。
 */

import fs from "node:fs";
import { execFileSync } from "node:child_process";

import {
  HUB_DIR,
  logError,
  setLocked,
  setUnlocked,
} from "./config.js";
import { getInstances, pushToInstances } from "./instance-manager.js";
import { channelPlugins } from "./channel-registry.js";
import { loadChannelState } from "./state.js";

export function getLockPhrase(): string {
  // Security-critical: lock-phrase is the panic button. 读失败绝不静默返空——
  // 若文件损坏返空会让用户以为"我设了暗号还能救命"，实际已失效。
  // 读失败 logError + return ""——caller（isLockTrigger）应该在启动时再做一次
  // self-check 或 warning，确保不是"无声失效"。
  const phraseFile = `${HUB_DIR}/lock-phrase.json`;
  if (!fs.existsSync(phraseFile)) return "";
  try {
    const data = JSON.parse(fs.readFileSync(phraseFile, "utf-8"));
    return (data.phrase ?? "").trim();
  } catch (err) {
    logError(`🚨 lock-phrase.json 读取失败（panic button 暗号将失效）: ${String(err)}`);
    return "";
  }
}

export function isLockTrigger(content: string): boolean {
  const phrase = getLockPhrase();
  if (!phrase) return false; // No phrase configured = lock trigger disabled
  return content.trim() === phrase;
}

function broadcastToChannels(text: string): void {
  for (const [name, plugin] of channelPlugins) {
    // Best-effort: send to all allowlisted users on each channel.
    // Per-send failure is logged but not thrown — broadcast 是 best-effort
    // (lock/unlock 通知)，不能因为一个通道挂了停掉其他。
    const allowlist = (loadChannelState(name, "allowlist") ?? { allowed: [] }) as { allowed: { id: string }[] };
    for (const entry of allowlist.allowed) {
      plugin.send({ to: entry.id, content: text, type: "text" }).catch((err) => {
        logError(`broadcast 失败 [${name}/${entry.id.slice(0, 16)}]: ${String(err).slice(0, 200)}`);
      });
    }
  }
}

export function triggerLock(by: string): void {
  setLocked(by);
  // Notify all WebSocket instances
  const instances = getInstances();
  pushToInstances([...instances.keys()], {
    type: "system" as any,
    channel: "hub",
    from: "system",
    fromId: "system",
    content: `🔒 Hub 紧急锁定（by ${by}）。所有远程通道已关闭：入站消息不再转发给你，你的 hub_reply 也会被拦截。这是用户触发的安全功能，不是故障。等用户在 Terminal 说"解锁"或跑 fh hub unlock 后恢复。锁定期间你不需要做任何事。`,
    targeted: false,
    raw: {},
  });
  // Broadcast to all channels (one last message)
  broadcastToChannels("🔒 Hub 已锁定");
  // macOS notification
  try {
    execFileSync("/usr/bin/osascript", ["-e", 'display notification "所有远程通道已关闭" with title "🔒 Hub 已锁定"']);
  } catch {}
}

export function triggerUnlock(): void {
  setUnlocked();
  // Notify all WebSocket instances
  const instances = getInstances();
  pushToInstances([...instances.keys()], {
    type: "system" as any,
    channel: "hub",
    from: "system",
    fromId: "system",
    content: "🔓 Hub 已解锁。远程通道已恢复。",
    targeted: false,
    raw: {},
  });
  // Broadcast to all channels
  broadcastToChannels("🔓 Hub 已解锁");
  // macOS notification
  try {
    execFileSync("/usr/bin/osascript", ["-e", 'display notification "远程通道已恢复" with title "🔓 Hub 已解锁"']);
  } catch {}
}
