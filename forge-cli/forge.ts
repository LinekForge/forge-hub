#!/usr/bin/env bun
/**
 * forge CLI — Forge 系统管理工具
 *
 * MCP 管推送和高频通信，CLI 管一切其他操作。
 *
 * Usage:
 *   fh hub status|peers|channels|send|summary
 *   fh engine list|remove|pause|log
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import {
  buildEngineLogEntry,
  findEngineRemoveMatches,
  formatLocalTimestamp,
  getEnginePaths,
  listEngineSchedules,
  updateEnginePauseConfig,
} from "./engine.js";
import {
  formatInstanceChannels,
  formatInstanceLabel,
  formatInstanceName,
  formatInstanceTag,
  formatKnownState,
  partitionInstances,
  timeSince,
} from "./hub-instance-view.js";
import { resolveSelfTestHarnessPath } from "./self-test.js";

// ── Config ──────────────────────────────────────────────────────────────────

const HUB_URL = process.env.FORGE_HUB_URL ?? "http://localhost:9900";

// Token source: env var first (for test / override), then ~/.forge-hub/api-token
// file (chmod 600). See hub-client/hub-channel.ts for rationale.
function readAuthToken(): string {
  const fromEnv = process.env.HUB_API_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const home = process.env.HOME ?? "~";
    const tokenFile = path.join(home, ".forge-hub", "api-token");
    if (fs.existsSync(tokenFile)) {
      return fs.readFileSync(tokenFile, "utf-8").trim();
    }
  } catch { /* ignore */ }
  return "";
}

const HUB_API_TOKEN = readAuthToken();

function authHeaders(): Record<string, string> {
  return HUB_API_TOKEN ? { "Authorization": `Bearer ${HUB_API_TOKEN}` } : {};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

async function hubGet(endpoint: string): Promise<unknown> {
  try {
    const res = await fetch(`${HUB_URL}${endpoint}`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    die(`Hub 连接失败 (${HUB_URL}): ${String(err)}`);
  }
}

async function hubPost(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  try {
    const res = await fetch(`${HUB_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    die(`Hub 连接失败 (${HUB_URL}): ${String(err)}`);
  }
}

async function hubDelete(endpoint: string): Promise<unknown> {
  try {
    const res = await fetch(`${HUB_URL}${endpoint}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      // DELETE 对 404 想让 CLI 显示具体错误，别 die 卡住
      const body = await res.text().catch(() => "<read body failed>");
      throw new Error(`HTTP ${res.status}: ${body}`);
    }
    return await res.json();
  } catch (err) {
    die(`Hub 请求失败 (${HUB_URL}${endpoint}): ${String(err)}`);
  }
}

// ── Hub Commands ────────────────────────────────────────────────────────────

async function hubStatus() {
  const data = await hubGet("/status") as {
    hub: { version: string; uptime: number; memory_mb: number; lock: { locked: boolean } };
    channels: Record<string, { loaded: boolean; health_status?: string; consecutiveFailures?: number; lastError?: string; messagesIn: number; messagesOut: number }>;
    instances: { id: string; tag?: string; description?: string; isChannel?: boolean; channels?: string[]; presence?: "live" | "known"; connectedAt?: string; lastSeenAt?: string }[];
  };
  const { live, known } = partitionInstances(data.instances);
  console.log(`Forge Hub v${data.hub.version}${data.hub.lock.locked ? " 🔒 已锁定" : ""}`);
  console.log(`运行 ${data.hub.uptime}s · ${data.hub.memory_mb}MB`);
  console.log(`在线实例: ${live.length}${live.length > 0 ? ` (${live.map((instance) => formatInstanceName(instance)).join(", ")})` : ""}`);
  if (known.length > 0) {
    console.log(`已知但不在线: ${known.length} (${known.map((instance) => formatInstanceName(instance)).join(", ")})`);
  }
  const chEntries = Object.entries(data.channels);
  if (chEntries.length === 0) {
    console.log("已加载通道: 0");
  } else {
    console.log(`已加载通道: ${chEntries.length}`);
    for (const [name, ch] of chEntries) {
      const status = ch.health_status ?? "unknown";
      const icon = status === "healthy" ? "✓" : status === "degraded" ? "⚠" : status === "unhealthy" ? "✗" : "?";
      const stats = `in:${ch.messagesIn} out:${ch.messagesOut}`;
      const extra = ch.consecutiveFailures && ch.consecutiveFailures > 0
        ? ` (连续${ch.consecutiveFailures}次失败${ch.lastError ? `: ${ch.lastError.slice(0, 50)}` : ""})`
        : "";
      console.log(`  ${icon} ${name} [${status}] ${stats}${extra}`);
    }
  }
}

function hubSetLockPhrase(args: string[]) {
  const phrase = args.join(" ").trim();
  if (!phrase) die("用法: fh hub set-lock-phrase <暗号>");
  const phraseFile = `${process.env.HOME}/.forge-hub/lock-phrase.json`;
  fs.writeFileSync(phraseFile, JSON.stringify({ phrase, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
  console.log(`锁定暗号已设置。查看：fh hub lock-phrase`);
}

function hubLockPhrase() {
  const phraseFile = `${process.env.HOME}/.forge-hub/lock-phrase.json`;
  if (!fs.existsSync(phraseFile)) {
    console.log("未设置锁定暗号。用 fh hub set-lock-phrase <暗号> 设置。");
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(phraseFile, "utf-8"));
    console.log(`当前暗号: ${data.phrase}`);
    console.log(`设置时间: ${data.updatedAt ?? "未知"}`);
  } catch (err) {
    // 文件存在但无法解析——这是 anomaly，不能误导用户成"未设置"
    console.error(`❌ ${phraseFile} 损坏: ${err instanceof Error ? err.message : String(err)}`);
    console.error("   暗号配置不可读。建议 cat 这个文件检查格式，或重新 set-lock-phrase。");
    console.error("   ⚠️ 损坏期间 panic button 可能失效（hub 加载时也读不出来）。");
  }
}

async function hubLock() {
  const res = await fetch(`${HUB_URL}/lock`, { method: "POST", headers: authHeaders() });
  const data = await res.json() as { success: boolean };
  if (data.success) {
    console.log("🔒 Hub 已锁定。所有远程通道已关闭。");
    console.log("解锁：fh hub unlock");
  }
}

async function hubUnlock() {
  // Security (redteam A1): unlock 是高风险动作——解除 panic button。仅依赖
  // HUB_API_TOKEN 不够（token 泄漏场景下 attacker 可反复 unlock 抵消锁定）。
  // 这里加 Touch ID 作第二道：CLI 层 attacker 需本人在机前按指纹。
  // HTTP /unlock 本身仍然校验 token——server 端加 Touch ID 需要 architecture
  // 变更（一次性 attestation），留 post-launch。
  const verified = await touchIdVerify("Forge Hub 解锁: 恢复所有远程通道");
  if (!verified) {
    console.log("❌ Touch ID 验证失败，解锁已取消");
    return;
  }
  const res = await fetch(`${HUB_URL}/unlock`, { method: "POST", headers: authHeaders() });
  const data = await res.json() as { success: boolean };
  if (data.success) {
    console.log("🔓 Hub 已解锁。远程通道已恢复。");
  }
}

async function hubHealth() {
  const data = await hubGet("/status") as {
    hub: { version: string; pid: number; uptime: number; memory_mb: number; started_at: string };
    channels: Record<string, {
      loaded: boolean; messagesIn: number; messagesOut: number; errors: number;
      lastMessageIn?: string; lastMessageOut?: string; lastError?: string;
      health_status?: "healthy" | "degraded" | "unhealthy" | "unknown";
      consecutiveFailures?: number; lastSuccessAt?: string; lastFailureAt?: string;
    }>;
    instances: { id: string; tag?: string; description?: string; isChannel?: boolean; channels?: string[]; presence?: "live" | "known"; connectedAt?: string; lastSeenAt?: string }[];
  };
  const { live, known } = partitionInstances(data.instances);

  console.log(`Forge Hub v${data.hub.version} · PID ${data.hub.pid} · ${data.hub.memory_mb}MB`);
  console.log(`运行 ${data.hub.uptime}s · 启动于 ${data.hub.started_at}`);
  console.log("");

  console.log("通道健康:");
  const statusIcon: Record<string, string> = {
    healthy: "✅", degraded: "⚠️", unhealthy: "❌", unknown: "❓",
  };
  for (const [ch, h] of Object.entries(data.channels)) {
    const lastIn = h.lastMessageIn ? timeSince(h.lastMessageIn) : "无";
    const lastOut = h.lastMessageOut ? timeSince(h.lastMessageOut) : "无";
    const errInfo = h.errors > 0 ? ` · ${h.errors} 错误` : "";
    const status = h.health_status ?? "unknown";
    const icon = statusIcon[status];
    const consFail = (h.consecutiveFailures ?? 0) > 0 ? ` · 连续失败 ${h.consecutiveFailures} 次` : "";
    console.log(`  ${icon} ${ch} [${status}]: 收${h.messagesIn} 发${h.messagesOut}${errInfo}${consFail}`);
    console.log(`    最近收:${lastIn} 发:${lastOut}`);
    if (h.lastFailureAt) console.log(`    最近失败:${timeSince(h.lastFailureAt)}${h.lastSuccessAt ? ` · 最近成功:${timeSince(h.lastSuccessAt)}` : " · 从未成功"}`);
    if (h.lastError) console.log(`    └ 最后错误: ${h.lastError.slice(0, 80)}`);
  }
  console.log("");

  console.log(`在线实例: ${live.length}`);
  for (const instance of live) {
    console.log(`  ${formatInstanceName(instance)}${formatInstanceTag(instance)}`);
  }
  if (known.length > 0) {
    console.log("");
    console.log(`已知但不在线: ${known.length}`);
    for (const instance of known) {
      console.log(`  ${formatInstanceName(instance)}${formatInstanceTag(instance)} · ${formatKnownState(instance)}`);
    }
  }
}

async function hubPeers() {
  const data = await hubGet("/instances") as {
    instances: { id: string; tag?: string; description?: string; isChannel?: boolean; channels?: string[]; presence?: "live" | "known"; connectedAt?: string; lastSeenAt?: string; summary?: string }[];
  };
  const { live, known } = partitionInstances(data.instances);
  if (live.length === 0 && known.length === 0) {
    console.log("没有在线或已知实例");
    return;
  }
  if (live.length > 0) {
    console.log("在线实例:");
    for (const instance of live) {
      const summary = instance.summary ? ` — ${instance.summary}` : "";
      console.log(`${instance.id}${formatInstanceLabel(instance)} [${formatInstanceChannels(instance)}]${summary}`);
    }
  } else {
    console.log("在线实例: 0");
  }
  if (known.length > 0) {
    console.log("");
    console.log("已知但不在线:");
    for (const instance of known) {
      console.log(`${instance.id}${formatInstanceLabel(instance)} [${formatKnownState(instance)}]`);
    }
  }
}

// ── Self-Test：对活 Hub 跑 8 个场景，断言内部状态变化 + 进程级 isolation ──────
async function hubSelfTest() {
  // self-test 走**独立 test harness binary**——不碰生产 Hub。
  // harness 内部 spawn 一个临时 Hub（不同 port + tmp HUB_DIR），跑 scenarios，清理。
  // 生产 Hub 代码里完全没有 /test/* endpoint——见 hub-test-harness/harness.ts 顶部注释。
  const resolution = resolveSelfTestHarnessPath({
    repoRootOverride: process.env.FORGE_HUB_REPO,
  });
  const harnessPath = resolution.path;

  if (!fs.existsSync(harnessPath)) {
    console.error(`❌ test harness 未找到: ${harnessPath}`);
    console.error("   已尝试:");
    for (const candidate of resolution.tried) {
      console.error(`   - ${candidate}`);
    }
    console.error("   如果仓库不在这些位置，可设 FORGE_HUB_REPO=/你的/forge-hub/仓库根目录");
    process.exit(1);
  }

  const child = spawn("bun", [harnessPath], {
    stdio: "inherit",  // 直接把 harness 的输出转到我们的 stdout
    env: process.env,
  });

  await new Promise<void>((resolve) => {
    child.on("close", (code: number | null) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
}

async function hubApprovalAudit(args: string[]) {
  const auditFile = path.join(process.env.HOME ?? "~", ".forge-hub", "audit.jsonl");
  if (!fs.existsSync(auditFile)) {
    console.log("audit.jsonl 不存在");
    return;
  }
  const lines = (fs.readFileSync(auditFile, "utf-8") as string).trim().split("\n");
  const approvalActions = new Set([
    "approval_pushed", "approval_granted", "approval_denied",
    "approval_mismatch", "approval_timeout", "approval_push_failed",
  ]);

  // 解析参数：--last N (default 20)、--today、--request-id <id>
  let limit = 20;
  let todayOnly = false;
  let filterRequestId: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--last" && args[i + 1]) { limit = Number(args[i + 1]) || 20; i++; }
    else if (args[i] === "--today") todayOnly = true;
    else if (args[i] === "--request-id" && args[i + 1]) { filterRequestId = args[i + 1]; i++; }
  }
  const today = new Date().toISOString().slice(0, 10);

  type AuditEntry = { ts: string; action: string; [k: string]: unknown };
  const entries: AuditEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      if (!approvalActions.has(e.action)) continue;
      if (todayOnly && !e.ts.startsWith(today)) continue;
      if (filterRequestId && e.request_id !== filterRequestId) continue;
      entries.push(e);
    } catch {}
  }
  const tail = entries.slice(-limit);
  if (tail.length === 0) {
    console.log("没有匹配的审批审计记录");
    return;
  }
  console.log(`${tail.length} 条审批审计记录（共 ${entries.length} 条符合条件）：\n`);
  for (const e of tail) {
    const time = String(e.ts).slice(11, 19);  // HH:MM:SS
    const date = String(e.ts).slice(0, 10);
    const icon = {
      approval_pushed: "🔐",
      approval_granted: "✅",
      approval_denied: "❌",
      approval_mismatch: "⚠️",
      approval_timeout: "⏰",
      approval_push_failed: "💥",
    }[e.action as string] || "•";
    const tool = e.tool_name ? ` ${e.tool_name}` : "";
    const req = e.request_id ? ` [${e.request_id}]` : "";
    console.log(`${date} ${time} ${icon} ${e.action}${tool}${req}`);
    if (e.description) console.log(`    ${e.description}`);
    if (e.action === "approval_granted" || e.action === "approval_denied") {
      console.log(`    回复渠道: ${e.reply_channel}:${e.reply_from} · 等待 ${e.waited_seconds}s`);
    }
    if (e.action === "approval_mismatch") {
      console.log(`    word=${e.verdict_word} 但 id=${e.display_id} 绑定=${e.expected_behavior}`);
    }
    if (e.action === "approval_timeout") {
      console.log(`    instance=${e.from_instance} online=${e.instance_online} waited=${Math.round(Number(e.waited_ms) / 60000)}min`);
    }
    if (e.action === "approval_push_failed") {
      console.log(`    失败: ${Array.isArray(e.failures) ? e.failures.join("; ") : e.failures}`);
    }
  }
}

async function hubReplay(args: string[]) {
  if (args.length < 1) die("用法: fh hub replay <channel> [count=50] [since_ts]");
  const channel = args[0];
  const limit = args[1] ? parseInt(args[1], 10) : 50;
  const sinceTs = args[2];
  const qs = new URLSearchParams({ channel, limit: String(limit) });
  if (sinceTs) qs.set("since_ts", sinceTs);
  const data = await hubGet(`/history?${qs.toString()}`) as { channel: string; history: { ts: string; direction?: string; from?: string; text?: string }[] };
  if (!data.history || data.history.length === 0) {
    console.log(`【${channel}】无匹配历史`);
    return;
  }
  console.log(`【${channel} · ${data.history.length} 条】`);
  for (const h of data.history) {
    const time = new Date(h.ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const arrow = h.direction === "in" ? "←" : h.direction === "out" ? "→" : "·";
    console.log(`${time} ${arrow} ${h.from ?? "?"}: ${h.text ?? ""}`);
  }
}

async function hubPending() {
  const data = await hubGet("/pending") as {
    count: number;
    pending: {
      request_id: string; yes_id: string; no_id: string;
      tool_name: string; description: string;
      from_instance: string; created_at: string;
      waited_seconds: number; remaining_seconds: number;
      pushed_channels: string[];
    }[];
  };
  if (data.count === 0) {
    console.log("没有挂起的审批");
    return;
  }
  console.log(`${data.count} 个挂起审批：\n`);
  for (const p of data.pending) {
    const waited = p.waited_seconds < 60 ? `${p.waited_seconds}s` : `${Math.round(p.waited_seconds / 60)}min`;
    const remaining = Math.round(p.remaining_seconds / 60);
    console.log(`• ${p.tool_name}: ${p.description}`);
    console.log(`  id: ${p.request_id} (yes=${p.yes_id} / no=${p.no_id})`);
    console.log(`  from: ${p.from_instance}`);
    console.log(`  已等: ${waited} · 剩余超时: ${remaining}min · 推送到: [${p.pushed_channels.join(", ")}]`);
    console.log("");
  }
}

async function hubResolve(args: string[]) {
  if (args.length === 0) {
    die("用法: fh hub resolve <request_id>\n  手动清除一条 stale pending 审批（当 Claude Code 本地已 resolve 但 Hub 没收到 cancel 时）。");
  }
  const id = args[0];
  const data = await hubDelete(`/pending/${encodeURIComponent(id)}`) as { success: boolean; cleaned?: string; tool_name?: string; error?: string };
  if (data.success) {
    console.log(`✓ 已清除 pending ${data.cleaned} (tool=${data.tool_name})`);
  } else {
    die(`清除失败: ${data.error ?? "unknown"}`);
  }
}

async function hubChannels() {
  const data = await hubGet("/channels") as { channels: ({ id: string; name: string; aliases: string[] } | string)[] };
  if (data.channels.length === 0) {
    console.log("没有已加载通道");
    return;
  }
  for (const ch of data.channels) {
    if (typeof ch === "string") {
      console.log(`- ${ch}`);
    } else {
      const aliases = ch.aliases.length > 0 ? ` (${ch.aliases.join(", ")})` : "";
      console.log(`- ${ch.name}${aliases} — ${ch.id}`);
    }
  }
}

async function hubSend(args: string[]) {
  if (args.length < 3) die("用法: fh hub send <channel> <to> <text>");
  const [channel, to, ...textParts] = args;
  const text = textParts.join(" ");
  const result = await hubPost("/send", { channel, to, text }) as { success: boolean; error?: string };
  if (result.success) {
    console.log("已发送");
  } else {
    die(`发送失败: ${result.error}`);
  }
}

async function hubName(args: string[]) {
  if (args.length < 2) die("用法: fh hub name <instance_id> <name>");
  const [instanceId, ...nameParts] = args;
  const name = nameParts.join(" ");
  const result = await hubPost("/set-name", { instance: instanceId, name }) as { success: boolean };
  if (result.success) {
    console.log(`已改名: ${instanceId} → ${name}`);
  } else {
    die("改名失败（实例不在线？）");
  }
}

async function hubSummary(args: string[]) {
  if (args.length === 0) die("用法: fh hub summary <text>\n  （可选 @TAG 指定实例，否则检测当前实例）");
  const { instanceId, rest } = await resolveInstanceId(args);
  if (rest.length === 0) die("用法: fh hub summary <text>");
  const summary = rest.join(" ");
  const result = await hubPost("/set-summary", { instance: instanceId, summary }) as { success: boolean };
  if (result.success) {
    console.log(`✅ ${instanceId} → ${summary}`);
  } else {
    die("设置失败（实例不在线？）");
  }
}

// ── Channel Short Names ────────────────────────────────────────────────────

const CHANNEL_ALIASES: Record<string, string> = {
  wx: "wechat", wechat: "wechat",
  tg: "telegram", telegram: "telegram",
  im: "imessage", imessage: "imessage",
  fs: "feishu", feishu: "feishu",
};

function resolveChannel(name: string): string {
  return CHANNEL_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
}

// ── Instance Detection ─────────────────────────────────────────────────────

async function detectInstanceId(): Promise<string | null> {
  // CLI's process.ppid is the shell, not CC — CC → shell → CLI chain.
  // Walk up ppid until we find a pid that has ~/.claude/sessions/<pid>.json
  // (CC writes that file per its own pid). First hit = CC pid.
  // hub-client registers as forge-<process.ppid> (which = CC pid since hub-client
  // is a direct CC child), so using CC pid here makes both sides match.
  let pid = process.ppid;
  for (let i = 0; i < 5; i++) {
    const sessionFile = path.join(process.env.HOME ?? "~", ".claude", "sessions", `${pid}.json`);
    if (fs.existsSync(sessionFile)) return `forge-${pid}`;
    try {
      const ppid = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf-8" }).trim();
      pid = parseInt(ppid, 10);
      if (isNaN(pid) || pid <= 1) break;
    } catch { break; }
  }
  return null;
}

async function resolveInstanceId(args: string[]): Promise<{ instanceId: string; rest: string[] }> {
  // Check for --instance @TAG or first arg starts with @
  let tag: string | null = null;
  let rest = [...args];

  const instIdx = args.indexOf("--instance");
  if (instIdx >= 0 && args[instIdx + 1]) {
    tag = args[instIdx + 1].replace(/^@/, "");
    rest = [...args.slice(0, instIdx), ...args.slice(instIdx + 2)];
  } else if (args[0]?.startsWith("@")) {
    tag = args[0].slice(1);
    rest = args.slice(1);
  }

  if (tag) {
    // Find instance by tag OR id (L1: @<id> is a valid manual override, not only @<tag>)
    const data = await hubGet("/instances") as { instances: { id: string; tag?: string; isChannel?: boolean; presence?: "live" | "known"; connectedAt?: string; lastSeenAt?: string }[] };
    const { live, known } = partitionInstances(data.instances);
    const liveMatches = live.filter((instance) => instance.tag === tag || instance.id === tag);
    const exactLive = liveMatches.find((instance) => instance.id === tag);
    const inst = exactLive ?? liveMatches[0];
    if (!exactLive && liveMatches.length > 1) {
      const ids = liveMatches.map((instance) => `${instance.id}${instance.tag ? `(@${instance.tag})` : ""}`).join(", ");
      die(`@${tag} 匹配到多个在线实例：${ids}。请先修正重复 tag，或直接用 @实例ID 指定。`);
    }
    if (!inst) {
      const knownMatches = known.filter((instance) => instance.tag === tag || instance.id === tag);
      const exactKnown = knownMatches.find((instance) => instance.id === tag);
      const knownMatch = exactKnown ?? knownMatches[0];
      const ids = live.map((instance) => instance.id).join(", ");
      if (!exactKnown && knownMatches.length > 1) {
        const labels = knownMatches.map((instance) => `${instance.id}${instance.tag ? `(@${instance.tag})` : ""}`).join(", ");
        die(`@${tag} 匹配到多个离线实例：${labels}。请先修正重复 tag。`);
      }
      if (knownMatch) {
        die(`@${tag} 当前不在线（${formatKnownState(knownMatch)}）。在线实例: ${ids || "无"}`);
      }
      die(`找不到 @${tag}。在线实例: ${ids || "无"}`);
    }
    return { instanceId: inst.id, rest };
  }

  // Auto-detect current instance
  const id = await detectInstanceId();
  if (!id) die("无法检测当前实例。用 @标签 指定实例：fh hub listen @A wechat tg");
  return { instanceId: id!, rest };
}

async function hubListen(args: string[]) {
  // No args: show current subscription for all online instances
  if (args.length === 0) {
    const data = await hubGet("/instances") as { instances: { id: string; tag?: string; description?: string; isChannel?: boolean; channels?: string[]; presence?: "live" | "known"; connectedAt?: string; lastSeenAt?: string }[] };
    const { live, known } = partitionInstances(data.instances);
    if (live.length === 0) {
      console.log("没有在线实例");
      if (known.length > 0) {
        console.log(`已知但不在线: ${known.map((instance) => `${instance.id} (${formatKnownState(instance)})`).join(", ")}`);
      }
      return;
    }
    for (const instance of live) {
      const label = instance.description && instance.tag ? `${instance.description}@${instance.tag}` : instance.description ?? instance.tag ?? "";
      console.log(`${instance.id}${label ? ` (${label})` : ""} → [${formatInstanceChannels(instance)}]`);
    }
    return;
  }

  const { instanceId, rest } = await resolveInstanceId(args);
  if (rest.length === 0) die("请指定通道: wx, tg, im, all");

  let channels: string[] | undefined;
  if (rest.length === 1 && rest[0].toLowerCase() === "all") {
    channels = undefined; // clear subscription
  } else {
    channels = rest.map(resolveChannel);
  }

  const body = channels ? { instance: instanceId, channels } : { instance: instanceId, channels: ["all"] };
  const result = await hubPost("/set-channels", body) as { success: boolean };
  if (result.success) {
    const label = channels ? channels.join(", ") : "全部";
    console.log(`✅ ${instanceId} → [${label}]`);
  } else {
    // L4: tell user what's actually registered so they can `@<id>` manually
    const data = await hubGet("/instances") as { instances: { id: string; presence?: "live" | "known"; connectedAt?: string }[] };
    const { live } = partitionInstances(data.instances);
    const ids = live.map((instance) => instance.id).join(", ");
    die(`设置失败（${instanceId} 未注册）。在线: ${ids || "无"}\n手动指定: fh hub listen @<id> <ch...>`);
  }
}

// ── Hub Allow / Revoke ─────────────────────────────────────────────────────

const HUB_STATE = path.join(process.env.HOME ?? "~", ".forge-hub", "state");
const AUDIT_FILE = path.join(process.env.HOME ?? "~", ".forge-hub", "audit.jsonl");

type HubAllowlist = {
  allowed: { id: string; nickname: string }[];
  auto_allow_next?: boolean;
  approval_owner_id?: string;
};

function loadAllowlist(channel: string): HubAllowlist {
  const filePath = path.join(HUB_STATE, channel, "allowlist.json");
  if (!fs.existsSync(filePath)) return { allowed: [] };
  // Fail-closed：损坏的 allowlist **不能**静默返空 —— 那样 allowlist 层全失守，
  // 任何 sender 都被当"未授权"拒 + 主人回审批无效。die() 强制管理员修。
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    die(`❌ ${filePath} 损坏无法解析: ${err instanceof Error ? err.message : String(err)}\n请检查 JSON 格式，或从备份恢复。`);
  }
}

function saveAllowlist(channel: string, allowlist: HubAllowlist): void {
  const dir = path.join(HUB_STATE, channel);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore — non-fatal */ }
  const clean: HubAllowlist = { allowed: allowlist.allowed };
  if (typeof allowlist.auto_allow_next === "boolean") clean.auto_allow_next = allowlist.auto_allow_next;
  if (allowlist.approval_owner_id) clean.approval_owner_id = allowlist.approval_owner_id;
  const allowlistPath = path.join(dir, "allowlist.json");
  const tmp = `${allowlistPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, allowlistPath);
    try { fs.chmodSync(allowlistPath, 0o600); } catch { /* ignore */ }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function appendAudit(action: string, channel: string, id: string, nickname: string): void {
  const entry = JSON.stringify({ ts: new Date().toISOString(), action, channel, id, nickname });
  try {
    fs.appendFileSync(AUDIT_FILE, entry + "\n", "utf-8");
  } catch (err) {
    console.error(`❌ 审计日志写入失败: ${String(err)}`);
    die("审计日志不可写，授权操作中止");
  }
}

function resolveAllowlistEntry(allowlist: HubAllowlist, query: string): { id: string; nickname: string } | null {
  const exactId = allowlist.allowed.find((entry) => entry.id === query);
  if (exactId) return exactId;

  const nicknameMatches = allowlist.allowed.filter((entry) => entry.nickname === query);
  if (nicknameMatches.length > 1) {
    die(`nickname "${query}" 匹配到多条授权，请改用 sender_id 指定`);
  }
  return nicknameMatches[0] ?? null;
}

// Touch ID 验证策略：
//   - `FORGE_HUB_AUTH_MODE=touchid`（default）+ `touchid-verify` 可用 → Touch ID prompt
//   - `FORGE_HUB_AUTH_MODE=touchid` + binary 不存在 → 提示缺失 + 拒绝（fail-closed）
//   - `FORGE_HUB_AUTH_MODE=prompt` → 交互式终端二次确认（"请输入 y 确认"），没有 Touch ID 硬件
//     也能用，比"没验证"好
//   - `FORGE_HUB_AUTH_MODE=none` → 跳过验证（**不推荐**，仅用于 CI / 已完全信任的环境）
//
// `touchid-verify` binary 位置：
//   - 优先 env `FORGE_TOUCHID_BIN` 绝对路径
//   - default `~/bin/touchid-verify`
// 开源用户可以从 https://github.com/mattrajca/touchid-verify 或类似项目编译一份。
async function touchIdVerify(reason: string): Promise<boolean> {
  // Default 改为 prompt (redteam 终审 P0-3)——touchid-verify 二进制是外部 Swift
  // 项目需用户自编译，开箱即用场景下直接撞墙。prompt (终端交互) 零依赖，CC 用户
  // 和 agent 都能走通；想要 Touch ID 的用户设 FORGE_HUB_AUTH_MODE=touchid 升级。
  const mode = (process.env.FORGE_HUB_AUTH_MODE ?? "prompt").toLowerCase();

  if (mode === "none") {
    console.warn(`⚠️  FORGE_HUB_AUTH_MODE=none，跳过验证（${reason}）`);
    return true;
  }

  if (mode === "prompt") {
    // 交互式终端二次确认 fallback
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = (await rl.question(`🔐 ${reason}\n输入 'y' 确认，其他任意输入拒绝: `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  }

  // Default: touchid mode
  const touchIdBin = process.env.FORGE_TOUCHID_BIN ?? path.join(process.env.HOME ?? "~", "bin", "touchid-verify");
  if (!fs.existsSync(touchIdBin)) {
    console.error(`❌ Touch ID 工具不存在: ${touchIdBin}`);
    console.error("   方案一：安装 touchid-verify 到此路径（mac only）");
    console.error("   方案二：设 FORGE_HUB_AUTH_MODE=prompt 改用终端交互确认");
    console.error("   方案三：设 FORGE_HUB_AUTH_MODE=none 完全跳过（不推荐）");
    return false;
  }
  try {
    execFileSync(touchIdBin, [reason], { stdio: "inherit", timeout: 30_000 });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 区分 timeout / user-cancel / binary 错 —— 给用户 actionable 提示
    if (msg.includes("timed out") || msg.includes("ETIMEDOUT")) {
      console.error("❌ Touch ID 验证超时（30s）");
    } else if (msg.includes("ENOENT") || msg.includes("not found")) {
      console.error(`❌ Touch ID binary 执行错：${msg}`);
    } else {
      console.error(`❌ Touch ID 验证被拒或失败：${msg}`);
    }
    return false;
  }
}

async function hubAllow(args: string[]) {
  if (args.length < 3) die("用法: fh hub allow <channel> <id> <nickname>\n  channel: wechat/telegram/imessage/feishu");
  const [channel, id, ...nickParts] = args;
  const nickname = nickParts.join(" ");

  // Touch ID verification
  console.log(`授权请求: ${channel} / ${nickname} (${id})`);
  const verified = await touchIdVerify(`Forge Hub 授权: 添加 ${nickname} 到 ${channel}`);
  if (!verified) {
    console.log("❌ Touch ID 验证失败，授权已取消");
    return;
  }

  const allowlist = loadAllowlist(channel);
  // Check if already exists
  if (allowlist.allowed.some((e) => e.id === id)) {
    console.log(`已存在: ${nickname} (${id}) 在 ${channel} allowlist 中`);
    return;
  }

  allowlist.allowed.push({ id, nickname });
  saveAllowlist(channel, allowlist);
  appendAudit("allow", channel, id, nickname);
  console.log(`✅ 已授权: ${nickname} (${id}) → ${channel}`);
  if (!allowlist.approval_owner_id) {
    console.log(`⚠️  ${channel} 还没有审批 owner。下一步运行: fh hub owner ${channel} ${id}`);
  }
}

async function hubRevoke(args: string[]) {
  if (args.length < 2) die("用法: fh hub revoke <channel> <id|nickname>");
  const [channel, query] = args;

  // Touch ID verification
  console.log(`撤销请求: ${channel} / ${query}`);
  const verified = await touchIdVerify(`Forge Hub 授权: 撤销 ${query} 从 ${channel}`);
  if (!verified) {
    console.log("❌ Touch ID 验证失败，撤销已取消");
    return;
  }

  const allowlist = loadAllowlist(channel);
  const removedEntries = allowlist.allowed.filter((e) => e.id === query || e.nickname === query);
  const before = allowlist.allowed.length;
  allowlist.allowed = allowlist.allowed.filter((e) => e.id !== query && e.nickname !== query);
  const removed = before - allowlist.allowed.length;

  if (removed === 0) {
    console.log(`未找到: ${query} 不在 ${channel} allowlist 中`);
    return;
  }

  if (allowlist.approval_owner_id && removedEntries.some((entry) => entry.id === allowlist.approval_owner_id)) {
    allowlist.approval_owner_id = undefined;
    console.log(`⚠️  已同时清除 ${channel} 的审批 owner，请重新运行 fh hub owner ${channel} <id> 设置。`);
  }

  saveAllowlist(channel, allowlist);
  appendAudit("revoke", channel, query, "");
  console.log(`✅ 已撤销: ${query} 从 ${channel} (移除 ${removed} 条)`);
}

function hubAllowlist(args: string[]) {
  const channel = args[0];
  if (!channel) {
    // List all channels' allowlists
    try {
      const channels = fs.readdirSync(HUB_STATE).filter((d) => {
        const al = path.join(HUB_STATE, d, "allowlist.json");
        return fs.existsSync(al) && d !== "_hub";
      });
      for (const ch of channels) {
        const al = loadAllowlist(ch);
        console.log(`\n${ch} (${al.allowed.length}):`);
        console.log(`  owner: ${al.approval_owner_id ?? "(未设置)"}`);
        for (const e of al.allowed) {
          const ownerMark = al.approval_owner_id === e.id ? " [owner]" : "";
          console.log(`  ${e.nickname} — ${e.id}${ownerMark}`);
        }
      }
    } catch {}
    return;
  }

  const al = loadAllowlist(channel);
  if (al.allowed.length === 0) {
    console.log(`${channel} allowlist 为空`);
    console.log(`owner: ${al.approval_owner_id ?? "(未设置)"}`);
    return;
  }
  console.log(`owner: ${al.approval_owner_id ?? "(未设置)"}`);
  for (const e of al.allowed) {
    const ownerMark = al.approval_owner_id === e.id ? " [owner]" : "";
    console.log(`${e.nickname} — ${e.id}${ownerMark}`);
  }
}

async function hubOwner(args: string[]) {
  const [channel, query] = args;
  if (!channel) die("用法: fh hub owner <channel> [id|nickname|--clear]");

  const allowlist = loadAllowlist(channel);
  if (!query) {
    const owner = allowlist.approval_owner_id
      ? resolveAllowlistEntry(allowlist, allowlist.approval_owner_id)
      : null;
    if (!allowlist.approval_owner_id) {
      console.log(`${channel} 审批 owner: (未设置)`);
      return;
    }
    if (!owner) {
      console.log(`${channel} 审批 owner: ${allowlist.approval_owner_id} (已不在 allowlist 中)`);
      return;
    }
    console.log(`${channel} 审批 owner: ${owner.nickname} — ${owner.id}`);
    return;
  }

  const verified = await touchIdVerify(`Forge Hub 审批 owner: 更新 ${channel}`);
  if (!verified) {
    console.log("❌ 验证失败，owner 未修改");
    return;
  }

  if (query === "--clear") {
    allowlist.approval_owner_id = undefined;
    saveAllowlist(channel, allowlist);
    appendAudit("clear_owner", channel, "", "");
    console.log(`✅ 已清除 ${channel} 审批 owner`);
    return;
  }

  const entry = resolveAllowlistEntry(allowlist, query);
  if (!entry) {
    die(`找不到 ${query}。先运行 fh hub allow ${channel} <id> <nickname> 把它加入 allowlist。`);
  }

  allowlist.approval_owner_id = entry.id;
  saveAllowlist(channel, allowlist);
  appendAudit("set_owner", channel, entry.id, entry.nickname);
  console.log(`✅ ${channel} 审批 owner → ${entry.nickname} (${entry.id})`);
}

// ── Hub Presets ────────────────────────────────────────────────────────────

const PRESETS_FILE = path.join(process.env.HOME ?? "~", ".forge-hub", "channel-presets.json");

function loadPresetsData(): { name: string; subscribe?: string[]; history: Record<string, number> }[] {
  try {
    if (fs.existsSync(PRESETS_FILE)) return JSON.parse(fs.readFileSync(PRESETS_FILE, "utf-8"));
  } catch {}
  return [];
}

function savePresetsData(presets: { name: string; subscribe?: string[]; history: Record<string, number> }[]): void {
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2), "utf-8");
}

function hubPresetList() {
  const presets = loadPresetsData();
  if (presets.length === 0) {
    console.log("没有保存的预设\n提示: fh hub preset add \"只微信\" wx:200");
    return;
  }
  for (const p of presets) {
    const sub = p.subscribe ? p.subscribe.join(",") : Object.keys(p.history).join(",");
    const hist = Object.entries(p.history).map(([ch, n]) => `${ch}:${n}`).join(" ");
    console.log(`${p.name} → 订阅[${sub}] 历史[${hist}]`);
  }
}

function hubPresetAdd(args: string[]) {
  if (args.length < 2) die("用法: fh hub preset add <name> <channel:count ...>\n例: fh hub preset add \"只微信\" wx:200 tg:50");
  const name = args[0];
  const channelArgs = args.slice(1);
  const channels: Record<string, number> = {};
  const subscribe: string[] = [];
  for (const arg of channelArgs) {
    const [chRaw, countStr] = arg.split(":");
    const ch = resolveChannel(chRaw);
    const count = parseInt(countStr ?? "100", 10);
    channels[ch] = isNaN(count) ? 100 : count;
    subscribe.push(ch);
  }
  const presets = loadPresetsData().filter(p => p.name !== name);
  presets.push({ name, subscribe, history: channels });
  savePresetsData(presets);
  const chList = Object.entries(channels).map(([ch, n]) => `${ch}:${n}`).join(" ");
  console.log(`✅ 已添加预设: ${name} → ${chList}`);
}

function hubPresetRemove(args: string[]) {
  if (args.length === 0) die("用法: fh hub preset remove <name>");
  const name = args.join(" ");
  const presets = loadPresetsData();
  const filtered = presets.filter(p => p.name !== name);
  if (filtered.length === presets.length) {
    console.log(`未找到预设: ${name}`);
    return;
  }
  savePresetsData(filtered);
  console.log(`✅ 已删除预设: ${name}`);
}

// NOTE: 定时任务调度不属于 Hub 能力范畴。如需类似功能请用 system cron / launchd
// / 自己写 plugin。forge-hub 专注消息通道 + 远程审批。

// ── Engine Commands ────────────────────────────────────────────────────────

function engineList() {
  const { engineScheduleDir } = getEnginePaths();
  if (!fs.existsSync(engineScheduleDir)) {
    console.log("engine.d/ 不存在");
    return;
  }

  const lines = listEngineSchedules(engineScheduleDir);
  if (lines.length === 0) {
    console.log("没有定时任务");
    return;
  }

  for (const item of lines) console.log(item.line);
}

function engineRemove(args: string[]) {
  if (args.length === 0) {
    die("用法: fh engine remove <query|filename>");
  }

  const { engineScheduleDir } = getEnginePaths();
  if (!fs.existsSync(engineScheduleDir)) {
    console.log("engine.d/ 不存在");
    return;
  }

  const query = args.join(" ");
  const exactPath = path.join(engineScheduleDir, query);
  if (fs.existsSync(exactPath)) {
    fs.unlinkSync(exactPath);
    console.log(`已删除: ${query}`);
    return;
  }

  const matches = findEngineRemoveMatches(engineScheduleDir, query);
  if (matches.length === 0) {
    console.log(`没有找到包含"${query}"的任务`);
    return;
  }
  if (matches.length === 1) {
    fs.unlinkSync(path.join(engineScheduleDir, matches[0].file));
    console.log(`已删除: ${matches[0].file} @ ${matches[0].time} — ${matches[0].prompt}`);
    return;
  }

  console.log(`匹配到 ${matches.length} 个任务，请指定文件名:`);
  for (const match of matches) {
    console.log(`  ${match.file} @ ${match.time} — ${match.prompt}`);
  }
}

function enginePause(args: string[]) {
  const minutes = parseInt(args[0] ?? "30", 10);
  if (!Number.isFinite(minutes) || minutes < 0) {
    die("用法: fh engine pause [minutes>=0]");
  }

  const { engineDir, engineConfigFile } = getEnginePaths();
  fs.mkdirSync(engineDir, { recursive: true });

  try {
    const current = fs.existsSync(engineConfigFile)
      ? JSON.parse(fs.readFileSync(engineConfigFile, "utf-8")) as Record<string, unknown>
      : {};
    const next = updateEnginePauseConfig(current, minutes);
    fs.writeFileSync(engineConfigFile, JSON.stringify(next, null, 2), "utf-8");
    if (minutes <= 0) {
      console.log("Engine 已恢复");
      return;
    }
    const pauseUntil = String(next.pause_until);
    console.log(`Engine 已暂停 ${minutes} 分钟（到 ${formatLocalTimestamp(pauseUntil)}）`);
    console.log("Engine 会自动恢复。手动恢复：fh engine pause 0");
  } catch (err) {
    die(`暂停失败: ${String(err)}`);
  }
}

function engineLog(args: string[]) {
  const { engineDir, engineLogFile } = getEnginePaths();
  fs.mkdirSync(engineDir, { recursive: true });

  if (args[0] === "--read") {
    const n = parseInt(args[1] ?? "20", 10);
    try {
      if (!fs.existsSync(engineLogFile)) {
        console.log("行动日志为空");
        return;
      }
      const lines = fs.readFileSync(engineLogFile, "utf-8").trim().split("\n").filter(Boolean);
      console.log(lines.slice(-n).join("\n"));
    } catch (err) {
      die(`读取日志失败: ${String(err)}`);
    }
    return;
  }

  if (args.length === 0) {
    die("用法: fh engine log <text> 或 fh engine log --read [n]");
  }

  const text = args.join(" ");
  try {
    fs.appendFileSync(engineLogFile, buildEngineLogEntry(text), "utf-8");
    console.log(`已写入行动日志: ${text.slice(0, 60)}`);
  } catch (err) {
    die(`写入日志失败: ${String(err)}`);
  }
}

// ── Setup Wizard ─────────────────────────────────────────────────────────────

async function hubSetup(): Promise<void> {
  const home = process.env.HOME ?? "~";
  const configPath = path.join(home, ".forge-hub", "hub-config.json");

  console.log("Forge Hub 首次配置向导\n");

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, "utf-8")); } catch { /* start fresh */ }
    console.log("已有 hub-config.json，将在现有配置上补充。\n");
  }

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const channels = ["wechat", "telegram", "feishu", "imessage"];
  const existing = (config.approval_channels ?? []) as string[];

  console.log("可用通道: wechat (wx) / telegram (tg) / feishu (fs) / imessage (im)");
  if (existing.length > 0) {
    console.log(`当前 approval_channels: [${existing.join(", ")}]`);
  }

  const answer = await rl.question("\n审批推送到哪些通道？（逗号分隔，如 wx,tg；直接回车保持现有）: ");
  rl.close();

  if (answer.trim()) {
    const selected = answer.split(/[,\s]+/).map((s) => resolveChannel(s.trim())).filter((c) => channels.includes(c));
    if (selected.length === 0) {
      console.log("❌ 没有识别到有效的通道名。有效名: wechat/wx, telegram/tg, feishu/fs, imessage/im");
      return;
    }
    config.approval_channels = selected;
  } else if (existing.length === 0) {
    console.log("⚠ 未设置 approval_channels，远程审批会 auto-deny。稍后可编辑 ~/.forge-hub/hub-config.json 手动添加。");
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  fs.renameSync(tmp, configPath);
  console.log(`\n✓ 已写入 ${configPath}`);

  if ((config.approval_channels as string[] | undefined)?.length) {
    console.log(`  approval_channels: [${(config.approval_channels as string[]).join(", ")}]`);
  }

  console.log("\n下一步:");
  console.log("1. 授权你的联系人或群（从 hub log 里找到 sender_id）:");
  console.log("  fh hub allow <channel> <id> <nickname>\n");
  console.log("2. 显式设置审批 owner（不要依赖 allowlist 顺序）:");
  console.log("  fh hub owner <channel> <id|nickname>\n");
  console.log("例: fh hub allow wechat ou_xxxxx 小明");
  console.log("    fh hub owner wechat 小明");
}

// ── Main ────────────────────────────────────────────────────────────────────

const [domain, command, ...rest] = process.argv.slice(2);

if (!domain) {
  console.log(`forge — Forge 系统管理工具

用法:
  fh hub setup           首次配置向导（设置 approval_channels）
  fh hub lock            紧急锁定（关闭所有远程通道）
  fh hub unlock          解锁
  fh hub set-lock-phrase <暗号>  设置锁定暗号
  fh hub lock-phrase     查看当前暗号
  fh hub health          详细健康检查
  fh hub status          查看 Hub 状态
  fh hub peers           在线实例列表
  fh hub channels        已加载通道
  fh hub pending         当前挂起的审批队列
  fh hub resolve <id>    手动清除一条 stale pending（本地 resolved 但 Hub 没收到 cancel 时用）
  fh hub approval-audit [--last N] [--today] [--request-id ID]  查审批审计
  fh hub self-test       跑 8 个场景验证审批 + crash isolation（走 hub-test-harness 独立 binary，不碰生产 Hub）
  fh hub replay <ch> [count=50] [since_ts]  查某通道最近聊天历史
  fh hub send <ch> <to> <text>  发消息
  fh hub name <id> <name>  给实例起名（@路由用）
  fh hub summary <text>  设置实例描述
  fh hub listen              查看当前通道订阅
  fh hub listen [@TAG] <ch...>  设置通道订阅（wx/tg/im/fs/all）
  fh hub allow <ch> <id> <nick>  授权联系人或群（需 Touch ID）
  fh hub revoke <ch> <id|nick>   撤销授权（需 Touch ID）
  fh hub owner <ch> [id|nick|--clear]  查看或设置审批 owner
  fh hub allowlist [ch]          查看授权列表
  fh hub preset list             查看通道预设
  fh hub preset add <n> <ch:N>   添加预设（如 wx:200 tg:50）
  fh hub preset remove <n>       删除预设

  fh engine list                 查看定时任务
  fh engine remove <q|file>      删除定时任务
  fh engine pause [minutes]      暂停 engine（0 = 立即恢复）
  fh engine log <text>           记一条手动行动日志
  fh engine log --read [n]       查看最近 n 条行动日志`);
  process.exit(0);
}

if (domain === "hub") {
  switch (command) {
    case "setup": await hubSetup(); break;
    case "lock": await hubLock(); break;
    case "unlock": await hubUnlock(); break;
    case "set-lock-phrase": hubSetLockPhrase(rest); break;
    case "lock-phrase": hubLockPhrase(); break;
    case "health": await hubHealth(); break;
    case "status": await hubStatus(); break;
    case "peers": await hubPeers(); break;
    case "channels": await hubChannels(); break;
    case "pending": await hubPending(); break;
    case "resolve": await hubResolve(rest); break;
    case "approval-audit": await hubApprovalAudit(rest); break;
    case "self-test": await hubSelfTest(); break;
    case "replay": await hubReplay(rest); break;
    case "send": await hubSend(rest); break;
    case "name": await hubName(rest); break;
    case "summary": await hubSummary(rest); break;
    case "listen": await hubListen(rest); break;
    case "allow": await hubAllow(rest); break;
    case "revoke": await hubRevoke(rest); break;
    case "owner": await hubOwner(rest); break;
    case "allowlist": hubAllowlist(rest); break;
    case "preset": {
      const sub = rest[0];
      const subArgs = rest.slice(1);
      switch (sub) {
        case "list": hubPresetList(); break;
        case "add": hubPresetAdd(subArgs); break;
        case "remove": hubPresetRemove(subArgs); break;
        default: die("用法: fh hub preset list|add|remove");
      }
      break;
    }
    default: die(`未知命令: fh hub${command ?? ""}\n运行 forge 查看帮助`);
  }
} else if (domain === "engine") {
  switch (command) {
    case "list": engineList(); break;
    case "remove": engineRemove(rest); break;
    case "pause": enginePause(rest); break;
    case "log": engineLog(rest); break;
    default: die(`未知命令: fh engine ${command ?? ""}\n运行 forge 查看帮助`);
  }
} else {
  die(`未知域: ${domain}\n运行 forge 查看帮助`);
}
