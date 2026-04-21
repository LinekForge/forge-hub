#!/usr/bin/env bun
/**
 * Forge Hub — Forge 的统一通信总线
 *
 * 独立常驻进程。所有通道进来，所有实例连上，消息到对的地方。
 */

import fs from "node:fs";

import {
  HUB_VERSION,
  HUB_DIR,
  CONFIG_FILE,
  DEFAULT_PORT,
  DEFAULT_HOST,
  ensureDirs,
  readPreviousPid,
  writePid,
  removePid,
  recordInbound,
  getAllChannelHealth,
  loadLockState,
  isLocked,
  log,
  logError,
  formatUnauthorizedNotice,
  appendAudit,
  auditAllowlistPerms,
} from "./config.js";
import { loadChannels, stopAllChannels } from "./channel-loader.js";
import { setOnReadyCallback, getInstances, pushToInstances } from "./instance-manager.js";
import { route } from "./router.js";

// ── Pending 持久化 ──────────────────────────────────────────────────────────
//
// 04-13 加：Hub 重启会丢所有 pending，用户回旧 id 虽然会收到"不存在"ack，但如果用户从不回复，
// instance 侧就永远挂死。持久化到 state/_hub/pending.json，重启时恢复 Map + idLookup。
// 每次 pending 变动（登记/清理/超时）后全量覆盖写——pending 数不会多，无性能问题。

import type { HubConfig, InboundMessage } from "./types.js";

import {
  pendingPermissions,
  idLookup,
  PERMISSION_ID_RE,
  LOOSE_PERMISSION_ID_RE,
  savePendingToDisk,
  loadPendingFromDisk,
  startPendingTtlSweep,
  isApprovalOwner,
  sendApprovalAck,
} from "./approval.js";

// ── Load Config ─────────────────────────────────────────────────────────────

function loadConfig(): HubConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch (err) {
    logError(`读取配置失败: ${String(err)}`);
  }
  return {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    primary_instance: "",
    show_instance_tag: false,
  };
}

// ── Message Handler ─────────────────────────────────────────────────────────

// currentConfig 抽到 hub-state.ts，通过 setCurrentConfig/getCurrentConfig 访问。
// startedAt 已在 hub-state.ts（供 /status /health 读）——之前此处留了 dead
// const（redteam 2nd round S2），删除。

// 审批 state / TTL / ack → approval.ts；recipient resolve + subscription filter → resolve.ts。

import { isLockTrigger, triggerLock } from "./lock.js";

// 外壳：hub 内部的 route/filter/push 若 throw，不冒到调 pushMessage 的 channel 层。
// channel 的 polling loop 一般有 try/catch 兜底，但 imessage setInterval / feishu readline
// 是"事件回调"形态——同步 throw 会冒到 uncaughtException。这层包裹 = Hub 自身的 fail-safe。
function onMessage(msg: InboundMessage): void {
  try {
    onMessageImpl(msg);
  } catch (err) {
    logError(`onMessage 异常（channel=${msg.channel}, from=${msg.from}）: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
}

function onMessageImpl(msg: InboundMessage): void {
  // Lock trigger check BEFORE writing history — never write the phrase
  if (isLockTrigger(msg.content)) {
    appendHistory(msg.channel, "in", msg.from, "[锁定触发]");
    recordInbound(msg.channel);
    if (!isLocked()) {
      triggerLock(`${msg.channel}:${msg.from}`);
    }
    return;
  }

  // ── 第二道防线：非主人消息进到 onMessage 意味着通道层第一道过滤失效 ─────────
  // 本阶段 allowlist 只有用户，任何非主人消息进来都是异常事件（竞态/bug/regression）。
  // 行为：logError 留痕 + push 一条抗 injection 的 system 告警让Forge 察觉 + 丢弃原消息不路由。
  // fromId = "system" 的消息（通道层自己 push 的告警）跳过此 check 避免递归/误伤。
  if (msg.fromId !== "system") {
    const ownerCheck = isApprovalOwner(msg.channel, msg.fromId);
    if (!ownerCheck.ok) {
      logError(
        `第二道防线: allowlist 校验失败 (channel=${msg.channel}, fromId=${msg.fromId}): ${ownerCheck.error}. 消息丢弃.`,
      );
      return;
    }
    if (!ownerCheck.isOwner) {
      logError(
        `🚨 第二道防线触发：非主人消息进到 onMessage（第一道过滤失效！）` +
          `channel=${msg.channel} fromId=${msg.fromId} from=${msg.from} ` +
          `content=${JSON.stringify(msg.content.slice(0, 200))}`,
      );
      // Push 抗 injection 的 system 告警让Forge 察觉
      const notice = formatUnauthorizedNotice(msg.channel, msg.from, msg.fromId, msg.content);
      const alertMsg: InboundMessage = {
        channel: msg.channel,
        from: "system",
        fromId: "system",
        content: `[🚨 第二道防线告警]\n${notice}`,
        raw: {},
      };
      // 走普通路由把告警推给订阅了该通道的所有 instance（system 消息在下面的 system fromId 分支免疫此 check）
      appendHistory(msg.channel, "in", "system", "[🚨 第二道防线: 非主人消息]");
      recordInbound(msg.channel);
      if (!isLocked()) {
        const result = route(alertMsg, getInstances(), getCurrentConfig());
        const filtered = filterBySubscription(result.targets, msg.channel, result.targeted);
        if (filtered.length > 0) {
          pushToInstances(filtered, {
            type: "message",
            channel: msg.channel,
            from: "system",
            fromId: "system",
            content: alertMsg.content,
            targeted: false,
            raw: {},
          });
        }
      }
      return; // 丢弃原消息，绝不路由给Forge
    }
  }

  // ── 审批回复识别 ────────────────────────────────────────────────────────
  // 前置条件（用户的原则 04-13）：**仅当此刻有 pending 审批时**，才把 "yes/no + xxx" 视作审批回复。
  // 没 pending 时，用户说什么（"yes 可以"、"no 算了"、"yes abcde"）都是纯聊天，正常路由。
  // 这避免了"用户凑巧说了一句 yes abcde 被 Hub 当作编号不存在报错"的 false positive。
  if (pendingPermissions.size > 0) {
    // Malformed 检测：格式像审批但严格不过（长度/含 l/等）——要主人身份才回 malformed ack
    if (
      LOOSE_PERMISSION_ID_RE.test(msg.content) &&
      !PERMISSION_ID_RE.test(msg.content)
    ) {
      const ownerCheck = isApprovalOwner(msg.channel, msg.fromId);
      if (ownerCheck.ok && ownerCheck.isOwner) {
        const pendingList = [...pendingPermissions.values()]
          .map((p) => `• ${p.tool_name}: yes ${p.yes_id} / no ${p.no_id}`)
          .join("\n");
        logError(
          `审批回复格式错误: "${msg.content.slice(0, 50)}" from ${msg.channel}:${msg.from} ` +
            `(id 必须是 5 个小写字母且不含 l)`,
        );
        appendHistory(msg.channel, "in", msg.from, `[审批回复格式错误]`);
        recordInbound(msg.channel);
        void sendApprovalAck(
          msg.channel,
          msg.fromId,
          `⚠️ 审批回复格式错了（id 必须是 5 个小写字母，不含 l）\n` +
            `你发的："${msg.content.trim()}"\n\n` +
            `当前待审批：\n${pendingList}`,
        );
        return;
      }
      // 非主人 loose match：不处理，走普通路由
    }

    // 严格匹配：`yes <yes_id>` / `no <no_id>`（强绑定：verdict word 和 id 必须一致）
    const permMatch = msg.content.match(PERMISSION_ID_RE);
    if (permMatch) {
    const displayId = permMatch[2]!.toLowerCase();
    const verdict: "allow" | "deny" = permMatch[1]!.toLowerCase().startsWith("y") ? "allow" : "deny";

    // Anti-forgery: only accept replies from allowlisted owner of this channel.
    // 区分三态：check 失败 → logError 后丢弃；真·非主人 → 普通 log 后丢弃。
    const ownerCheck = isApprovalOwner(msg.channel, msg.fromId);
    if (!ownerCheck.ok) {
      logError(
        `审批回复 id=${displayId} 无法校验主人身份 ` +
          `(channel=${msg.channel}, fromId=${msg.fromId}): ${ownerCheck.error}`,
      );
      return;
    }
    if (!ownerCheck.isOwner) {
      log(`⚠️  审批回复 id=${displayId} 来自非主人 ${msg.channel}:${msg.fromId}，忽略`);
      return;
    }

    // idLookup 是权威入口：从 display id 查出内部 request_id + 期望的 verdict
    const lookup = idLookup.get(displayId);
    if (!lookup) {
      // 收到主人的审批回复但 id 不在 lookup——TTL 过期 / Hub 重启丢了 pending / id 从未发出
      logError(
        `审批回复 id=${displayId} 无对应登记 (TTL 过期/Hub 重启/id 从未发出): ` +
          `msg from ${msg.channel}:${msg.from} (${msg.fromId})`,
      );
      appendHistory(msg.channel, "in", msg.from, `[审批回复 id=${displayId} 无效]`);
      recordInbound(msg.channel);
      // 回 ack 让用户立即知道这个 id 失效——包括 Hub 重启后的场景
      // 用户看到"没找到"，就知道要去终端按 Esc 救会话，不用等半小时才察觉卡死
      void sendApprovalAck(
        msg.channel,
        msg.fromId,
        `⚠️ 没有找到编号 ${displayId} 的审批——可能已超时、Hub 重启、或编号输错。\n` +
          `如果会话还在等，去那个终端按 Esc 取消当前 tool call。`,
      );
      return;
    }

    // 强绑定校验：verdict word 必须匹配 id 的语义
    // 用户手滑："yes {no_id}" → lookup.behavior=deny 但 verdict=allow → 不一致 → 丢弃 + 回 ack 提示
    if (lookup.behavior !== verdict) {
      const requestId = lookup.request_id;
      const mismatchPending = pendingPermissions.get(requestId);
      logError(
        `审批回复 verdict/id 不一致（手滑或 autocorrect）: ` +
          `word=${verdict} 但 id=${displayId} 绑定的是 ${lookup.behavior}。` +
          `请主人重新用正确的 id 回复（pending 保持等待）。`,
      );
      appendAudit({
        action: "approval_mismatch",
        request_id: lookup.request_id,
        display_id: displayId,
        verdict_word: verdict,
        expected_behavior: lookup.behavior,
        reply_channel: msg.channel,
        reply_from: msg.from,
      });
      appendHistory(msg.channel, "in", msg.from, `[审批回复 id=${displayId} verdict 不一致]`);
      recordInbound(msg.channel);
      // 回 ack 让用户知道他打错了 + 正确的 id 是什么（pending 如果还在就能报全）
      if (mismatchPending) {
        const correctWord = lookup.behavior === "allow" ? "yes" : "no";
        void sendApprovalAck(
          msg.channel,
          msg.fromId,
          `⚠️ 审批字词和 id 不一致\n` +
            `你发的："${verdict === "allow" ? "yes" : "no"} ${displayId}"\n` +
            `但 ${displayId} 绑定的是"${correctWord}"\n\n` +
            `正确回复：\n回复 yes ${mismatchPending.yes_id} 批准\n回复 no ${mismatchPending.no_id} 拒绝`,
        );
      }
      return;
    }

    const requestId = lookup.request_id;
    const pending = pendingPermissions.get(requestId);
    if (!pending) {
      // idLookup 有但 pending 没了——是 bug（两个 map 不同步）。同时清理 orphan idLookup。
      logError(
        `内部不一致：idLookup[${displayId}]→${requestId} 但 pending 不存在，清理 orphan`,
      );
      idLookup.delete(displayId);
      savePendingToDisk();
      return;
    }

    // 清理：pending map + 两条 idLookup（yes_id 和 no_id）
    pendingPermissions.delete(requestId);
    idLookup.delete(pending.yes_id);
    idLookup.delete(pending.no_id);
    savePendingToDisk();
    appendHistory(msg.channel, "in", msg.from, `[审批 ${requestId}] ${verdict}`);
    recordInbound(msg.channel);

    const instance = getInstances().get(pending.from_instance);
    // 审计不依赖 instance 是否在线——用户的决策已下达就要审计
    appendAudit({
      action: verdict === "allow" ? "approval_granted" : "approval_denied",
      request_id: requestId,
      display_id: displayId,
      tool_name: pending.tool_name,
      description: pending.description,
      from_instance: pending.from_instance,
      instance_online: Boolean(instance),
      reply_channel: msg.channel,
      reply_from: msg.from,
      waited_seconds: Math.round((Date.now() - pending.created_at) / 1000),
    });
    if (!instance) {
      log(`⚠️  审批 ${requestId} 的发起实例 ${pending.from_instance} 已离线，丢弃回复（已审计）`);
      void sendApprovalAck(
        msg.channel,
        msg.fromId,
        `⚠️ ${verdict === "allow" ? "批准" : "拒绝"}已记录，但 ${pending.tool_name} 所在会话已离线，无法送达`,
      );
      return;
    }
    instance.send({
      type: "permission_response",
      channel: msg.channel,
      from: msg.from,
      fromId: msg.fromId,
      content: JSON.stringify({ request_id: requestId, behavior: verdict }),
      targeted: true,
      raw: {},
    });
    log(`✅ 审批 ${requestId} → ${verdict} via id=${displayId} (from ${msg.channel}:${msg.from} → ${pending.from_instance})`);
    // 成功 ack：用户能看到"Hub 确认已生效"，而不是盲信
    const verb = verdict === "allow" ? "✅ 已批准" : "❌ 已拒绝";
    void sendApprovalAck(
      msg.channel,
      msg.fromId,
      `${verb} ${pending.tool_name}\n(${pending.description})`,
    );
    return;
    }
  }

  // Normal message: record history + health
  appendHistory(msg.channel, "in", msg.from, msg.content);
  recordInbound(msg.channel);

  // When locked: log but don't forward
  if (isLocked()) {
    log(`← [${msg.channel}] ${msg.from}: ${msg.content.slice(0, 60)}... [已锁定，未转发]`);
    return;
  }

  const result = route(msg, getInstances(), getCurrentConfig());
  if (result.targets.length === 0) {
    log(`← [${msg.channel}] ${msg.from}: ${msg.content.slice(0, 60)}... (无在线实例)`);
    return;
  }
  const filtered = filterBySubscription(result.targets, msg.channel, result.targeted);
  if (filtered.length === 0) {
    log(`← [${msg.channel}] ${msg.from}: ${msg.content.slice(0, 60)}... (无订阅实例)`);
    return;
  }
  pushToInstances(filtered, {
    type: "message",
    channel: msg.channel,
    from: msg.from,
    fromId: msg.fromId,
    content: result.content,
    targeted: result.targeted,
    raw: msg.raw,
  });
  const targetInfo = result.targeted ? ` → ${filtered.join(",")}` : "";
  log(`← [${msg.channel}] ${msg.from}${targetInfo}: ${result.content.slice(0, 60)}${result.content.length > 60 ? "..." : ""}`);
}

// ── Channel Plugin Registry (shared) ────────────────────────────────────────
// Registry 抽到 channel-registry.ts——main() 用 populate() 填充，其他模块共享
// 同一 Map 引用。

import { appendHistory } from "./history.js";
import { channelPlugins, channelPluginsMeta, populate as populateRegistry } from "./channel-registry.js";
import { filterBySubscription } from "./resolve.js";
import { startServer } from "./endpoints.js";
import { setCurrentConfig, getCurrentConfig } from "./hub-state.js";
import { startChannelWatchdog } from "./channel-watchdog.js";
import { loadAllowlist } from "./state.js";

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  ensureDirs();
  auditAllowlistPerms();

  // ── Startup ─────────────────────────────────────────────────────────────
  loadLockState();
  const prevPid = readPreviousPid();
  writePid();
  log("────────────────────────────────────────");
  log(`Forge Hub v${HUB_VERSION} · PID ${process.pid}${prevPid ? ` · 上次 PID ${prevPid}` : ""}`);
  log("────────────────────────────────────────");

  const config = loadConfig();
  setCurrentConfig(config);

  if (!config.approval_channels?.length) {
    logError("⚠ approval_channels 未配置。远程审批请求会被 auto-deny。运行 fh hub setup 或编辑 ~/.forge-hub/hub-config.json 添加。");
  }

  // Write default config if not exists
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
    log("生成默认 hub-config.json");
  }

  // ── 热加载 hub-config.json ─────────────────────────────────────────────
  // macOS fs.watch 在一次写入经常触发 2 次 event（rename + change），debounce 200ms 去重。
  // 失败不 fatal——watch 挂了只是失去热加载能力，Hub 照常跑。
  let configReloadDebounce: ReturnType<typeof setTimeout> | null = null;
  try {
    fs.watch(CONFIG_FILE, (_event) => {
      if (configReloadDebounce) clearTimeout(configReloadDebounce);
      configReloadDebounce = setTimeout(() => {
        try {
          const fresh = loadConfig();
          // Diff 报告——让用户 tail log 看到生效的具体字段
          const oldCfg = getCurrentConfig() as unknown as Record<string, unknown>;
          const newCfg = fresh as unknown as Record<string, unknown>;
          const changedKeys: string[] = [];
          const allKeys = new Set([...Object.keys(newCfg), ...Object.keys(oldCfg)]);
          for (const k of allKeys) {
            const oldVal = JSON.stringify(oldCfg[k]);
            const newVal = JSON.stringify(newCfg[k]);
            if (oldVal !== newVal) changedKeys.push(`${k}: ${oldVal} → ${newVal}`);
          }
          setCurrentConfig(fresh);
          if (changedKeys.length > 0) {
            log(`🔄 hub-config.json 热加载: ${changedKeys.join(", ")}`);
          } else {
            log("🔄 hub-config.json 重新读取（无字段变更）");
          }
        } catch (err) {
          logError(`config 热加载失败: ${String(err)}`);
        }
      }, 200);
    });
    log("👁 fs.watch: 监听 hub-config.json");
  } catch (err) {
    logError(`fs.watch hub-config.json 失败: ${String(err)}`);
  }

  // Restore pending permissions from disk（Hub 重启/崩溃恢复）+ 启动 TTL sweep
  loadPendingFromDisk();
  startPendingTtlSweep();

  // Start HTTP server
  startServer(config);

  // Load channel plugins
  const loaded = await loadChannels(onMessage);
  populateRegistry(loaded.sendMap, loaded.metaMap);

  for (const channelName of loaded.sendMap.keys()) {
    const al = loadAllowlist(channelName);
    if (al.allowed.length === 0) {
      logError(`⚠ 通道 ${channelName} 的 allowlist 为空——远程消息将被全部拒绝。运行 fh hub allow ${channelName} <id> <nickname> 添加授权联系人。`);
    }
  }

  // Channel watchdog: 每 2 分钟检查 unhealthy 通道并自动 restart
  startChannelWatchdog(onMessage);

  // Register onReady callback: push history + context when client sends "ready"
  setOnReadyCallback((instanceId, historyConfig) => {
    const instance = getInstances().get(instanceId);
    if (!instance) return;

    // 全局开关：auto_replay_on_ready=false 时不推自动历史，pull-model（instance 用 hub_replay_history 工具自己拉）
    // default true 保持兼容。想开"纯净测试窗口"就在 hub-config.json 里设 false。
    const autoReplay = getCurrentConfig().auto_replay_on_ready !== false;
    // 每通道条数上限——default 10 轻量化（之前硬编码 100 对 CC context 太重）
    const replayCount = getCurrentConfig().auto_replay_count ?? 10;

    // Determine which channels to replay history for
    // If historyConfig present: use it (keys = channels to replay, values = counts)
    // If absent: fall back to subscribed channels, config.auto_replay_count each
    const historyChannels: Record<string, number> = autoReplay
      ? (historyConfig ?? Object.fromEntries((instance.channels ?? [...channelPlugins.keys()]).map(ch => [ch, replayCount])))
      : {};  // auto_replay 关闭 → 空对象 → 下面循环跑 0 次

    // Send history per channel
    let totalReplayed = 0;
    for (const [ch, limit] of Object.entries(historyChannels)) {
      if (limit <= 0) continue;
      try {
        const historyFile = `${HUB_DIR}/state/${ch}/chat-history.jsonl`;
        if (!fs.existsSync(historyFile)) continue;
        const lines = fs.readFileSync(historyFile, "utf-8").trim().split("\n").filter(Boolean);
        const entries = lines.slice(-limit).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        if (entries.length > 0) {
          instance.ws.send(JSON.stringify({ type: "history", channel: ch, entries }));
          totalReplayed += entries.length;
        }
      } catch (err) { log(`⚠ 回放 ${ch} 历史失败: ${String(err)}`); }
    }

    // Send context with full channel metadata
    const channelMeta = [...channelPluginsMeta.values()].map(p => ({
      id: p.name, name: p.displayName, aliases: p.aliases,
    }));
    instance.ws.send(JSON.stringify({
      type: "context",
      peers: getInstances().size,
      channels: channelMeta,
    }));

    log(`📜 已推送历史 ${totalReplayed} 条 + 上下文给 ${instanceId}`);
  });

  log(`Forge Hub 已启动 ✦ (${channelPlugins.size} 个通道)${isLocked() ? " 🔒 已锁定" : ""}`);

  // ── Graceful Shutdown ────────────────────────────────────────────────────
  async function shutdown(signal: string) {
    const uptime = Math.round(process.uptime());
    const health = getAllChannelHealth();
    const totalIn = Object.values(health).reduce((s, h) => s + h.messagesIn, 0);
    const totalOut = Object.values(health).reduce((s, h) => s + h.messagesOut, 0);
    log("────────────────────────────────────────");
    log(`收到 ${signal}，正常关闭`);
    log(`运行 ${uptime}s · 收 ${totalIn} 条 · 发 ${totalOut} 条`);
    log("────────────────────────────────────────");
    await stopAllChannels();
    removePid();
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // ── Process-level 兜底 ───────────────────────────────────────────────────
  // 任何 channel plugin 的 async loop、setInterval 回调、readline handler
  // throw 了没被 catch 都会冒到这里。default 行为是 crash 整个 Hub——
  // 单通道崩炸掉所有通道 = 灾难。记日志、不退出。
  // launchd 保活本可以恢复，但期间所有通道离线几秒 + pending 恢复有时差（即便有持久化）。
  process.on("uncaughtException", (err) => {
    logError(`🚨 uncaughtException（不退出）: ${err?.stack ?? String(err)}`);
  });
  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logError(`🚨 unhandledRejection（不退出）: ${detail}`);
  });
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
