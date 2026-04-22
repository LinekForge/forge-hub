/**
 * Forge Hub — Remote approval state + lifecycle
 *
 * Hub 的 panic-approval 核心：pendingPermissions（内存 Map + 磁盘持久化）、
 * idLookup（展示 ID → request_id/behavior 反查）、TTL sweep 超时清理、
 * ack 发送、allowlist 主人校验。
 *
 * 和 hub.ts onMessage 共享 state——所以 state 在这里 export，onMessage 层
 * import 读写。
 */

import type { PendingPermission } from "./types.js";
import {
  log,
  logError,
  appendAudit,
} from "./config.js";
import { getInstances } from "./instance-manager.js";
import { loadChannelState, readAllowlist, saveChannelState } from "./state.js";
import { channelPlugins } from "./channel-registry.js";
import { isAuthorizedSenderMatch } from "./message-auth.js";

// ── Constants ───────────────────────────────────────────────────────────────

export const PENDING_STATE_CHANNEL = "_hub";
export const PENDING_STATE_KEY = "pending";

export const PERMISSION_ID_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

/**
 * 宽松匹配：用户回复"像审批回复"但**不合法**的格式——yes/no 后跟任意字母 token。
 * 只在有 pending 时才启用检测，避免纯聊天误伤（用户说"yes ok"时不应该被当审批）。
 * 匹配但严格 PERMISSION_ID_RE 不通过 → 告诉用户格式错了并报当前正确 id。
 *
 * 触发场景（04-13 repro）：
 * - 用户手输 id 多/少一个字母（例如 "no dhefjd" 6 字母）
 * - 用户 id 里含 'l'（被我们的字母表排除）
 * - 大小写混用（/i 容忍）
 */
export const LOOSE_PERMISSION_ID_RE = /^\s*(y|yes|n|no)\s+[a-zA-Z]{1,10}\s*$/;

// TTL 设 240min (4h)，覆盖"用户在床上睡着几小时后才回审批"的真实使用场景。
// 超过 4h 再回基本就算了——到那时上游会话多半也早就失去意义。
export const PERMISSION_TTL_MS = 240 * 60 * 1000;

/** Claude Code 的 request_id 字母表：a-z 去掉 l（防和 1/I 混淆）。我们的展示 ID 沿用一致。 */
const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyz";

// ── State (shared mutable) ─────────────────────────────────────────────────

export const pendingPermissions = new Map<string, PendingPermission>();

/**
 * 展示 ID → 对应 request_id + 预期 verdict 的反查表。
 * 每个 pending 会登记两条：yes_id→allow、no_id→deny，严格绑定 verdict 语义。
 * 用户回复 "yes {id}" 时必须命中 allow 条目；"no {id}" 必须命中 deny 条目。
 * 任何一边不一致就拒绝处理（logError + drop），防手滑和 autocorrect。
 */
export const idLookup = new Map<string, { request_id: string; behavior: "allow" | "deny" }>();

// ── Display ID generator ────────────────────────────────────────────────────

export function genDisplayId(): string {
  let s = "";
  for (let i = 0; i < 5; i++) {
    s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  }
  return s;
}

/** 生成一对不冲突的 yes_id/no_id（都不等、都不已在 idLookup 里）。概率上几乎一次即中，循环做保险。 */
export function genDisplayIdPair(): { yes_id: string; no_id: string } {
  for (let attempt = 0; attempt < 100; attempt++) {
    const yes_id = genDisplayId();
    const no_id = genDisplayId();
    if (yes_id !== no_id && !idLookup.has(yes_id) && !idLookup.has(no_id)) {
      return { yes_id, no_id };
    }
  }
  // 25^5 = ~9.7M 空间，当前活跃 ID 数 ≤ 2×TTL窗口内审批数。正常情况 100 次绝无可能命中不了。
  throw new Error("无法生成不冲突的 display id pair（idLookup 溢出？）");
}

// ── Persistence ─────────────────────────────────────────────────────────────

/** 把当前 pendingPermissions Map 全量写入 state/_hub/pending.json，用于 Hub 重启后恢复 */
export function savePendingToDisk(): void {
  try {
    // Security (redteam A4): 持久化 sanitize——input_preview 可能含 bash 参数
    // 原文（密码、API key、路径）。重启后不会再 push prompt（用户已看过），
    // 所以磁盘上不需要保留 preview；内存仍然有。description 保留（给 audit 追溯
    // tool-level 语义，不含具体参数）。
    const list = [...pendingPermissions.values()].map(p => ({
      request_id: p.request_id,
      yes_id: p.yes_id,
      no_id: p.no_id,
      tool_name: p.tool_name,
      description: p.description,
      input_preview: "",
      from_instance: p.from_instance,
      created_at: p.created_at,
      pushed_channels: p.pushed_channels,
    }));
    saveChannelState(PENDING_STATE_CHANNEL, PENDING_STATE_KEY, list);
  } catch (err) {
    logError(`savePendingToDisk 失败: ${String(err)}`);
  }
}

/** 启动时从 state/_hub/pending.json 恢复 pendingPermissions + idLookup；过期的丢弃并记审计 */
export function loadPendingFromDisk(): void {
  const raw = loadChannelState(PENDING_STATE_CHANNEL, PENDING_STATE_KEY);
  if (!raw || !Array.isArray(raw)) return;
  const now = Date.now();
  let restored = 0;
  let expired = 0;
  for (const p of raw as PendingPermission[]) {
    // 最小字段校验——避免旧数据缺 yes_id/no_id 导致崩溃
    if (!p.request_id || !p.yes_id || !p.no_id || typeof p.created_at !== "number") {
      logError(`loadPendingFromDisk: 跳过字段不全的条目 ${JSON.stringify(p).slice(0, 100)}`);
      continue;
    }
    if (now - p.created_at > PERMISSION_TTL_MS) {
      // 已过期——丢弃 + 审计
      expired++;
      appendAudit({
        action: "approval_restart_timeout",
        request_id: p.request_id,
        tool_name: p.tool_name,
        from_instance: p.from_instance,
        waited_ms: now - p.created_at,
      });
      continue;
    }
    pendingPermissions.set(p.request_id, p);
    idLookup.set(p.yes_id, { request_id: p.request_id, behavior: "allow" });
    idLookup.set(p.no_id, { request_id: p.request_id, behavior: "deny" });
    restored++;
  }
  if (restored > 0 || expired > 0) {
    log(`♻️  从磁盘恢复 pending: ${restored} 条 active, ${expired} 条过期丢弃`);
    // 如果有丢弃的，持久化更新（移除过期的）
    if (expired > 0) savePendingToDisk();
  }
}

// ── TTL Sweep ───────────────────────────────────────────────────────────────

/** 启动定时 sweep，每 60s 扫一次 pending 过期清理 + 通知 instance + ack 用户 */
export function startPendingTtlSweep(): void {
  setInterval(() => {
    try {
      const now = Date.now();
      for (const [id, p] of pendingPermissions) {
        if (now - p.created_at > PERMISSION_TTL_MS) {
          // 必须通知 client：否则 client 的 MCP permission handler 无限挂起，Claude Code 卡死。
          // 这是 04-13 发现的 bug——原版只 delete map 不通知，client 永远等不到 response。
          // 发 behavior="deny" 让 CC 侧走现成的 deny 分支停下 tool call。
          const instance = getInstances().get(p.from_instance);
          if (instance) {
            try {
              instance.send({
                type: "permission_response",
                channel: "system",
                from: "hub",
                fromId: "hub",
                content: JSON.stringify({ request_id: id, behavior: "deny" }),
                targeted: true,
                raw: {},
              });
              log(`⏰ 审批请求 ${id} 超时清理 + 已 deny 通知 ${p.from_instance} (tool=${p.tool_name})`);
            } catch (sendErr) {
              // 通知失败要 logError——client 会继续挂死，是真 bug 不是日常
              logError(`审批 ${id} 超时通知 ${p.from_instance} 失败: ${String(sendErr)}`);
            }
          } else {
            log(`⏰ 审批请求 ${id} 超时清理 (tool=${p.tool_name}, instance=${p.from_instance} 已离线,无需通知)`);
          }
          appendAudit({
            action: "approval_timeout",
            request_id: id,
            tool_name: p.tool_name,
            description: p.description,
            from_instance: p.from_instance,
            instance_online: Boolean(getInstances().get(p.from_instance)),
            waited_ms: Date.now() - p.created_at,
          });
          // 回 ack 给用户：告诉他这个 pending 自动 deny 了。
          // 发到第一个成功推送过的通道（pushed_channels[0]）——那是他能看到原始审批的地方。
          const ackChannel = p.pushed_channels[0];
          if (ackChannel) {
            // fire-and-forget，不阻塞清理循环
            void (async () => {
              const to = await resolveApprovalRecipient(ackChannel);
              if (to) {
                await sendApprovalAck(
                  ackChannel,
                  to,
                  `⏰ 审批已超时自动拒绝\n${p.tool_name} (${p.description})\n(超过 240 分钟未回复)`,
                );
              }
            })();
          }
          // 同步清理 idLookup，避免孤儿 display id 占位
          idLookup.delete(p.yes_id);
          idLookup.delete(p.no_id);
          pendingPermissions.delete(id);
          savePendingToDisk();
        }
      }
    } catch (err) {
      // 防御性兜底：裸 throw 会冒到 uncaughtException 导致整个 hub crash
      logError(`pendingPermissions 清理循环异常: ${String(err)}`);
    }
  }, 60_000);
}

// ── Approval recipient + ownership ──────────────────────────────────────────

export function matchesApprovalOwner(
  channel: string,
  senderId: string,
  allowed: { id: string }[],
): boolean {
  const owner = allowed[0];
  if (!owner?.id) return false;
  return isAuthorizedSenderMatch(channel, senderId, owner.id);
}

/**
 * 解析审批消息的接收者——按通道读 allowlist 的第一个 allowed 条目。
 * 四个通道（wechat/telegram/imessage/feishu）allowlist 结构统一为 { allowed: [{ id, nickname }] }。
 * 区分"文件不存在（正常 disable）" vs "读取失败（配置损坏）"：后者 logError 让定位不绕弯。
 */
export async function resolveApprovalRecipient(channel: string): Promise<string | null> {
  const allowlistResult = readAllowlist(channel);
  if (!allowlistResult.ok) {
    const msg = `resolveApprovalRecipient(${channel}): ${allowlistResult.error}`;
    if (allowlistResult.error.startsWith("allowlist not found:")) log(msg);
    else logError(msg);
    return null;
  }
  const id = allowlistResult.allowlist.allowed[0]?.id;
  if (!id) {
    log(`resolveApprovalRecipient(${channel}): allowlist 里 allowed[0].id 为空`);
    return null;
  }
  return id;
}

/**
 * 判断 sender_id 是否是某通道 allowlist 中的主人。用于防伪造审批回复。
 * 返回三态：
 * - { ok: true, isOwner: true }  → 是主人
 * - { ok: true, isOwner: false } → 不是主人（真·陌生人）
 * - { ok: false, error }         → 检查本身失败（文件损坏、权限问题等）
 *
 * 调用方必须区分后两者——把 check-failed 当成 not-owner 会让主人的合法回复被静默吞掉，
 * 用户看到 log 里"非主人"会怀疑 fromId 格式/sender_id，方向完全错。
 */
export type OwnerCheckResult =
  | { ok: true; isOwner: boolean }
  | { ok: false; error: string };

export function isApprovalOwner(channel: string, fromId: string): OwnerCheckResult {
  const allowlistResult = readAllowlist(channel);
  if (!allowlistResult.ok) {
    return { ok: false, error: allowlistResult.error };
  }
  return {
    ok: true,
    isOwner: matchesApprovalOwner(channel, fromId, allowlistResult.allowlist.allowed),
  };
}

// ── Approval ack ────────────────────────────────────────────────────────────

/**
 * 给用户回一条审批反馈 ack，让他知道回复是否被 Hub 收到并生效。
 * 今天发现 bug 的根本是"Hub 收没收到是黑箱"——用户只能赌。ack 把所有 silent 路径变 loud。
 *
 * 三种触发场景调用：
 * - 审批成功：用户回复匹配且一致，Hub 发 `✅ 已批准/拒绝 {request_id}`
 * - Mismatch：用户 verdict word 和 id 语义不符，Hub 提示正确 id 让他重试（pending 不动）
 * - TTL 超时：Hub 主动 deny 清理时，告诉用户这个审批过期了
 *
 * 失败不 throw——ack 发不出去不应该影响主路径。失败 logError 留痕。
 */
export async function sendApprovalAck(
  channel: string,
  toId: string,
  content: string,
): Promise<void> {
  const plugin = channelPlugins.get(channel);
  if (!plugin) {
    logError(`sendApprovalAck: 通道 ${channel} 未注册，ack 丢弃`);
    return;
  }
  const ctxTokens = (loadChannelState(channel, "context-tokens") ?? {}) as Record<string, string>;
  const contextToken = ctxTokens[toId] ?? "";
  try {
    const r = await plugin.send({
      to: toId,
      content,
      type: "text",
      raw: { context_token: contextToken },
    });
    if (!r.success) {
      logError(`sendApprovalAck: ${channel}:${toId} send 返回 !success: ${r.error ?? "(no error)"}`);
    }
  } catch (err) {
    logError(`sendApprovalAck: ${channel}:${toId} 发送抛错: ${String(err)}`);
  }
}
