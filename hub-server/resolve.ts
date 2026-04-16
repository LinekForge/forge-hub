/**
 * Forge Hub — Recipient resolution & subscription filter
 *
 * - filterBySubscription: 根据 instance 的 channel 订阅过滤 inbound 分发目标
 * - resolveRecipient: 把 `to` 解析成 native ID（如果本来就是）或用 allowlist
 *   查昵称。Plugin 先通过自己的 isNativeId（redteam A6 下放），第三方 plugin
 *   未实现时走全局 fallback regex。
 */

import { log } from "./config.js";
import { getInstances } from "./instance-manager.js";
import { channelPlugins } from "./channel-registry.js";
import { loadChannelState } from "./state.js";

export function filterBySubscription(targets: string[], channel: string, targeted: boolean): string[] {
  if (targeted) return targets; // @mention bypasses subscription
  const instances = getInstances();
  return targets.filter((id) => {
    const inst = instances.get(id);
    if (!inst?.channels) return true; // undefined = listen to all
    return inst.channels.includes(channel);
  });
}

// ── Nickname → ID Resolution ───────────────────────────────────────────────

interface AllowEntry { id: string; nickname: string }
interface Allowlist { allowed: AllowEntry[] }

/**
 * Fallback native-ID 检测（redteam A6）——保留给没实现 plugin.isNativeId 的
 * 第三方通道。内部通道（wechat/telegram/feishu/imessage）各自实现 isNativeId。
 */
function looksLikeNativeIdFallback(to: string): boolean {
  if (to.includes("@im.wechat")) return true;     // 微信
  if (/^\d{5,}$/.test(to)) return true;            // 电报（纯数字 5+ 位）
  if (to.startsWith("oc_")) return true;            // 飞书 chat ID
  if (to.startsWith("ou_")) return true;            // 飞书 user ID
  if (to.includes(";-;")) return true;              // iMessage chat_guid
  return false;
}

export function resolveRecipient(
  channel: string,
  to: string,
): { ok: true; id: string } | { ok: false; error: string } {
  // Plugin-specific isNativeId takes precedence; fallback to legacy global regex
  // for backward compat with third-party plugins that haven't implemented it yet.
  const plugin = channelPlugins.get(channel);
  const isNative = plugin?.isNativeId?.(to) ?? looksLikeNativeIdFallback(to);
  if (isNative) return { ok: true, id: to };

  // Look up nickname in allowlist
  const allowlist = (loadChannelState(channel, "allowlist") ?? { allowed: [] }) as Allowlist;
  const matches = allowlist.allowed.filter((e) => e.nickname === to);

  if (matches.length === 1) {
    log(`📇 昵称解析: "${to}" → ${matches[0].id} (${channel})`);
    return { ok: true, id: matches[0].id };
  }

  if (matches.length === 0) {
    return { ok: false, error: `找不到联系人 "${to}"（${channel} allowlist 中无此昵称）` };
  }

  // Multiple matches — ambiguous
  const ids = matches.map((m) => m.id).join(", ");
  return { ok: false, error: `昵称 "${to}" 有歧义，匹配到 ${matches.length} 个: ${ids}。请用完整 ID` };
}
