/**
 * Forge Engine 调度器
 *
 * 配置 → 展开 → 排定 → 触发 → 日志
 * 热加载时只重排变化的配置文件，其他不动。
 */

import fs from "node:fs";
import path from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import {
  CONFIG_FILE,
  SCHEDULE_FILE,
  SCHEDULE_DIR,
  ACTION_LOG_FILE,
  PID_FILE,
  log,
  logError,
} from "./config.js";
import {
  loadForgeConfig,
  loadScheduleDir,
  formatContacts,
  getPrimarySenderId,
  startConfigWatcher,
  ensureDirs,
  initDefaultConfig,
} from "./config-loader.js";
import { renderTemplate, buildTimeVars } from "./template.js";
import { scanHandlers } from "./handler-loader.js";
import { loadState, saveState } from "./state.js";
import type {
  ForgeConfig,
  ResolvedEntry,
  ScheduleHandler,
  RawScheduleEntry,
  ScheduleFile,
} from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function timeStr(h: number, m: number): string {
  return `${pad2(h)}:${pad2(m)}`;
}

function dateStr(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// ── Module State ────────────────────────────────────────────────────────────

const timersByOrigin = new Map<string, ReturnType<typeof setTimeout>[]>();
const entriesByOrigin = new Map<string, ResolvedEntry[]>();
let midnightTimer: ReturnType<typeof setTimeout> | null = null;
let handlers = new Map<string, ScheduleHandler>();
let currentConfig: ForgeConfig = { enabled: true, scan_dir: true, contacts: {} };
let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
let isPassive = false;

// ── Random Expansion ────────────────────────────────────────────────────────

export function expandRandom(entry: RawScheduleEntry): RawScheduleEntry[] {
  const start = entry.active_start ?? 6;
  const end = entry.active_end ?? 22;
  const count = Math.max(0, Math.floor(entry.daily_count ?? 10));
  const perHour = Math.max(0, Math.floor(entry.min_per_hour ?? 1));
  const hours = Math.max(0, end - start);

  if (hours === 0 || count === 0) return [];

  const expanded: RawScheduleEntry[] = [];
  const base = { ...entry, expand: undefined };

  // daily_count is the hard cap. min_per_hour is best-effort within that budget.
  for (let round = 0; round < perHour && expanded.length < count; round++) {
    for (let offset = 0; offset < hours && expanded.length < count; offset++) {
      expanded.push({
        ...base,
        hour: start + offset,
        minute: Math.floor(Math.random() * 60),
      });
    }
  }

  while (expanded.length < count) {
    expanded.push({
      ...base,
      hour: start + Math.floor(Math.random() * hours),
      minute: Math.floor(Math.random() * 60),
    });
  }

  return expanded;
}

// ── Resolve ─────────────────────────────────────────────────────────────────

function resolve(raw: RawScheduleEntry, origin: string): ResolvedEntry {
  return {
    hour: raw.hour,
    minute: raw.minute,
    second: raw.second ?? 0,
    template: raw.template,
    handler: raw.handler,
    sender: raw.sender || process.env.HUB_AGENT_NAME || "engine",
    prompt: raw.prompt,
    label: raw.label,
    weekdays: raw.weekdays,
    days: raw.days,
    months: raw.months,
    start_date: raw.start_date,
    end_date: raw.end_date,
    one_shot: raw.one_shot,
    source: raw.source ?? "manual",
    permission: raw.permission ?? "auto",
    origin,
    raw,
  };
}

function resolveAll(rawEntries: RawScheduleEntry[]): ResolvedEntry[] {
  const resolved: ResolvedEntry[] = [];

  for (const entry of rawEntries) {
    const origin = entry._origin ?? "unknown";

    if (entry.expand === "random") {
      for (const e of expandRandom(entry)) {
        resolved.push(resolve(e, origin));
      }
    } else {
      resolved.push(resolve(entry, origin));
    }
  }

  resolved.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  return resolved;
}

// ── Time Rules ──────────────────────────────────────────────────────────────

/**
 * 统一时间规则检查。所有条件都满足才触发。
 */
function shouldFire(entry: ResolvedEntry): boolean {
  const now = new Date();

  if (entry.weekdays?.length && !entry.weekdays.includes(now.getDay())) return false;
  if (entry.days?.length && !entry.days.includes(now.getDate())) return false;
  if (entry.months?.length && !entry.months.includes(now.getMonth() + 1)) return false;
  if (entry.start_date && now < new Date(entry.start_date + "T00:00:00")) return false;
  if (entry.end_date && now > new Date(entry.end_date + "T23:59:59")) return false;

  return true;
}

function canScheduleToday(entry: ResolvedEntry, today: string = dateStr()): boolean {
  if (entry.start_date && entry.start_date > today) return false;
  if (entry.end_date && entry.end_date < today) return false;
  return true;
}

export function removeScheduleEntryFromFile(
  filePath: string,
  entryIndex: number,
): { removed: boolean; remaining: number } {
  const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ScheduleFile & Record<string, unknown>;
  const schedules = Array.isArray(data.schedules) ? data.schedules : [];

  if (entryIndex < 0 || entryIndex >= schedules.length) {
    return { removed: false, remaining: schedules.length };
  }

  const nextSchedules = schedules.filter((_entry, index) => index !== entryIndex);

  if (nextSchedules.length === 0) {
    fs.unlinkSync(filePath);
  } else {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...data, schedules: nextSchedules }, null, 2),
      "utf-8",
    );
  }

  return { removed: true, remaining: nextSchedules.length };
}

function removeOneShotEntry(entry: ResolvedEntry): void {
  if (entry.origin === "unknown") return;

  const entryIndex = entry.raw._entry_index;
  if (typeof entryIndex !== "number") return;

  const filePath = path.join(SCHEDULE_DIR, entry.origin);
  const result = removeScheduleEntryFromFile(filePath, entryIndex);

  if (!result.removed) return;

  if (result.remaining === 0) {
    log(`🗑 一次性任务已删除，源文件已清空: ${entry.origin}`);
    return;
  }

  log(`🗑 一次性任务已删除: ${entry.origin}#${entryIndex}`);
}

// ── Fire ────────────────────────────────────────────────────────────────────

async function fire(entry: ResolvedEntry, server: Server): Promise<void> {
  if (!shouldFire(entry)) return;

  try {
    // Build content
    let content: string;
    let sender = entry.sender;

    if (entry.handler && handlers.has(entry.handler)) {
      const h = handlers.get(entry.handler)!;
      const tv = buildTimeVars();
      const result = h.buildContent(entry, tv.time, currentConfig);
      content = result.content;
      sender = result.sender;
    } else if (entry.template) {
      const tv = buildTimeVars();
      content = renderTemplate(entry.template, {
        ...tv,
        label: entry.label ?? "",
        prompt: entry.prompt ?? "",
        contacts: formatContacts(currentConfig.contacts),
      });
    } else {
      logError(`条目无 template 也无 handler，跳过`);
      return;
    }

    log(`⚡ 触发 [${sender}] @ ${timeStr(entry.hour, entry.minute)} (${entry.origin})`);

    await server.notification({
      method: "notifications/claude/channel",
      params: {
        content,
        meta: { sender, sender_id: getPrimarySenderId(currentConfig.contacts) },
      },
    });

    appendLog(entry, content);
    updateState(sender);

    // Auto-delete one_shot
    if (entry.one_shot) {
      removeOneShotEntry(entry);
    }
  } catch (err) {
    logError(`触发失败 [${entry.sender}] @ ${timeStr(entry.hour, entry.minute)}: ${String(err)}`);
  }
}

// ── Logging & State ─────────────────────────────────────────────────────────

// ── Trigger Log Rotation ───────────────────────────────────────────────────

const TRIGGER_LOG_MAX_SIZE = 512 * 1024; // 512KB
const TRIGGER_LOG_KEEP = 2;              // keep .1, .2

function rotateTriggerLogIfNeeded(): void {
  try {
    if (!fs.existsSync(ACTION_LOG_FILE)) return;
    const stat = fs.statSync(ACTION_LOG_FILE);
    if (stat.size < TRIGGER_LOG_MAX_SIZE) return;

    for (let i = TRIGGER_LOG_KEEP; i >= 1; i--) {
      const from = i === 1 ? ACTION_LOG_FILE : `${ACTION_LOG_FILE}.${i - 1}`;
      const to = `${ACTION_LOG_FILE}.${i}`;
      if (i === TRIGGER_LOG_KEEP) {
        try { fs.unlinkSync(to); } catch { /* cleanup best-effort */ }
      }
      try {
        fs.renameSync(from, to);
      } catch (err) {
        if (!String(err).includes("ENOENT")) throw err;
      }
    }
    log(`📜 触发日志已轮转 (>${TRIGGER_LOG_MAX_SIZE / 1024}KB)`);
  } catch (err) {
    logError(`触发日志轮转失败: ${String(err)}`);
  }
}

function appendLog(entry: ResolvedEntry, content: string): void {
  const now = new Date();
  const line = `\n## ${dateStr(now)} ${timeStr(now.getHours(), now.getMinutes())} — ${entry.sender}\n- 来源: ${entry.origin}\n- 内容: ${content.slice(0, 100)}${content.length > 100 ? "..." : ""}\n`;
  try {
    rotateTriggerLogIfNeeded();
    fs.appendFileSync(ACTION_LOG_FILE, line, "utf-8");
  } catch (err) { logError(`触发日志写入失败: ${String(err)}`); }
}

function appendSystemLog(event: string): void {
  const now = new Date();
  const line = `\n## ${dateStr(now)} ${timeStr(now.getHours(), now.getMinutes())} — [系统]\n- ${event}\n`;
  try {
    rotateTriggerLogIfNeeded();
    fs.appendFileSync(ACTION_LOG_FILE, line, "utf-8");
  } catch (err) { logError(`系统日志写入失败: ${String(err)}`); }
}

function updateState(sender: string): void {
  const s = loadState("global");
  s.last_fire = new Date().toISOString();
  s.last_sender = sender;
  s.today_count = ((s.today_count as number) || 0) + 1;
  saveState("global", s);
}

// ── Schedule ────────────────────────────────────────────────────────────────

const MISSED_WINDOW_MS = 2 * 60 * 60 * 1000;

function scheduleOrigin(origin: string, entries: ResolvedEntry[], server: Server): number {
  const now = Date.now();
  const today = dateStr();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let count = 0;
  const missed: { label: string; time: string }[] = [];

  for (const entry of entries) {
    if (!canScheduleToday(entry, today)) continue;

    const target = new Date();
    target.setHours(entry.hour, entry.minute, entry.second, 0);
    const delay = target.getTime() - now;
    if (delay > 0) {
      timers.push(setTimeout(() => fire(entry, server), delay));
      count++;
    } else if (delay > -MISSED_WINDOW_MS && !entry.one_shot) {
      missed.push({
        label: entry.label ?? entry.sender,
        time: timeStr(entry.hour, entry.minute),
      });
    }
  }

  if (missed.length > 0) {
    const list = missed.map(m => `- ${m.time} ${m.label}`).join("\n");
    log(`⏰ 发现 ${missed.length} 个错过的任务（2h 内），通知用户`);
    setTimeout(() => {
      server.notification({
        method: "notifications/claude/channel",
        params: {
          content: `[错过的任务] 以下今日任务在启动前已错过：\n${list}\n\n如需补跑请告诉我。`,
          meta: { sender: process.env.HUB_AGENT_NAME || "engine", sender_id: getPrimarySenderId(currentConfig.contacts) },
        },
      }).catch(err => logError(`错过任务通知发送失败: ${String(err)}`));
    }, 3000);
  }

  timersByOrigin.set(origin, timers);
  entriesByOrigin.set(origin, entries);
  return count;
}

function clearOrigin(origin: string): void {
  for (const t of timersByOrigin.get(origin) ?? []) clearTimeout(t);
  timersByOrigin.delete(origin);
  entriesByOrigin.delete(origin);
}

function clearAll(): void {
  for (const origin of timersByOrigin.keys()) clearOrigin(origin);
}

// ── Save Schedule ───────────────────────────────────────────────────────────

function saveSchedule(): void {
  const all: ResolvedEntry[] = [];
  for (const entries of entriesByOrigin.values()) all.push(...entries);
  all.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));

  try {
    fs.writeFileSync(SCHEDULE_FILE, JSON.stringify({
      date: dateStr(),
      total: all.length,
      times: all.map((e) => ({
        time: timeStr(e.hour, e.minute),
        sender: e.sender,
        label: e.label,
        origin: e.origin,
      })),
    }, null, 2), "utf-8");
  } catch (err) { logError(`schedule 快照写入失败: ${String(err)}`); }
}

// ── Reload ──────────────────────────────────────────────────────────────────

function checkPauseExpiry(config: ForgeConfig): void {
  const c = config as any;
  if (!c.enabled && c.pause_until) {
    if (Date.now() >= new Date(c.pause_until).getTime()) {
      c.enabled = true;
      delete c.pause_until;
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8"); } catch (err) { logError(`暂停恢复写回失败: ${String(err)}`); }
      log("⏯ Engine 暂停到期，已自动恢复");
    }
  }
}

function fullReload(server: Server): void {
  currentConfig = loadForgeConfig();
  checkPauseExpiry(currentConfig);
  if (!currentConfig.enabled) { clearAll(); log("⏸ Engine 已禁用"); return; }

  clearAll();
  const resolved = resolveAll(loadScheduleDir());

  // Group by origin
  const byOrigin = new Map<string, ResolvedEntry[]>();
  for (const e of resolved) {
    if (!byOrigin.has(e.origin)) byOrigin.set(e.origin, []);
    byOrigin.get(e.origin)!.push(e);
  }

  let total = 0;
  for (const [origin, entries] of byOrigin) total += scheduleOrigin(origin, entries, server);

  saveSchedule();
  log(`📋 今日已排定 ${total}/${resolved.length} 条`);
  appendSystemLog(`全部排定: ${total}/${resolved.length} 条`);
}

function partialReload(changedOrigin: string, server: Server): void {
  currentConfig = loadForgeConfig();
  checkPauseExpiry(currentConfig);
  if (!currentConfig.enabled) { clearAll(); log("⏸ Engine 已禁用"); return; }

  const oldCount = entriesByOrigin.get(changedOrigin)?.length ?? 0;
  clearOrigin(changedOrigin);

  const changed = resolveAll(loadScheduleDir()).filter((e) => e.origin === changedOrigin);
  const scheduled = scheduleOrigin(changedOrigin, changed, server);

  saveSchedule();
  log(`📋 部分重排: ${changedOrigin} (${oldCount} → ${changed.length} 条，排定 ${scheduled})`);
  appendSystemLog(`部分重排: ${changedOrigin} (${oldCount} → ${changed.length} 条，排定 ${scheduled})`);
}

// ── Expired Task Cleanup ────────────────────────────────────────────────────

function cleanExpiredTasks(): void {
  try {
    const today = dateStr();
    const files = fs.readdirSync(SCHEDULE_DIR).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SCHEDULE_DIR, file), "utf-8"));
        const schedules = data.schedules ?? [];
        const allExpired = schedules.length > 0 && schedules.every((s: RawScheduleEntry) =>
          s.end_date && s.end_date < today && s.source === "ai"
        );
        if (allExpired) {
          fs.unlinkSync(path.join(SCHEDULE_DIR, file));
          log(`🧹 过期任务已清理: ${file}`);
          appendSystemLog(`过期任务已清理: ${file}`);
        }
      } catch (err) { logError(`过期任务清理失败 (${file}): ${String(err)}`); }
    }
  } catch (err) { logError(`过期任务目录扫描失败: ${String(err)}`); }
}

// ── Midnight ────────────────────────────────────────────────────────────────

function scheduleMidnight(server: Server): void {
  const midnight = new Date();
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  const delay = midnight.getTime() - Date.now();

  midnightTimer = setTimeout(() => {
    log("🌙 午夜重排");
    appendSystemLog("午夜重排");

    // Reset daily state
    const s = loadState("global");
    s.today_count = 0;
    s.last_reset = new Date().toISOString();
    saveState("global", s);

    // Clean up expired AI tasks (end_date in the past)
    cleanExpiredTasks();

    fullReload(server);
    scheduleMidnight(server);
  }, delay);

  log(`🌙 下次重排: 明天 00:00（${Math.round(delay / 60000)} 分钟后）`);
}

// ── PID Lock ───────────────────────────────────────────────────────────────

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to acquire the PID lock.
 * Returns true if this instance should be the active scheduler.
 * Returns false if another live instance already holds the lock (passive mode).
 */
function acquirePidLock(): boolean {
  try {
    // Attempt exclusive create — fails if file already exists
    fs.writeFileSync(PID_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // Unexpected error (permission, disk, etc.) — log and proceed as active
      logError(`PID 文件写入失败: ${String(err)}，按 active 模式继续`);
      return true;
    }
  }

  // File exists — check if the holder is still alive
  try {
    const existingPid = Number(fs.readFileSync(PID_FILE, "utf-8").trim());
    if (existingPid && isProcessAlive(existingPid)) {
      return false; // Another live scheduler — we are passive
    }
  } catch {
    // Can't read / parse — treat as stale
  }

  // Stale PID file — overwrite and take ownership
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (err) {
    logError(`PID 文件覆写失败: ${String(err)}`);
  }
  return true;
}

function releasePidLock(): void {
  try {
    const content = fs.readFileSync(PID_FILE, "utf-8").trim();
    if (Number(content) === process.pid) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // Already gone or not ours — fine
  }
}

// ── Start ───────────────────────────────────────────────────────────────────

export function stopScheduler(): void {
  clearAll();
  if (midnightTimer) {
    clearTimeout(midnightTimer);
    midnightTimer = null;
  }
  if (reloadDebounce) {
    clearTimeout(reloadDebounce);
    reloadDebounce = null;
  }
  releasePidLock();
  isPassive = false;
}

export async function startScheduler(server: Server): Promise<void> {
  ensureDirs();
  initDefaultConfig();

  if (!acquirePidLock()) {
    isPassive = true;
    log("🔇 passive mode — 另一个 engine 实例正在调度，本实例跳过定时排程");
    return;
  }

  const cfg = loadForgeConfig();
  if (Object.keys(cfg.contacts).length === 0) {
    logError("⚠️  engine-config.json 的 contacts 为空——任务通知将缺少 sender_id，请编辑 contacts 字段添加联系人");
  }

  handlers = await scanHandlers();
  fullReload(server);
  scheduleMidnight(server);

  // Hot reload with debounce (100ms)
  startConfigWatcher((changedOrigin: string | null) => {
    if (reloadDebounce) clearTimeout(reloadDebounce);
    reloadDebounce = setTimeout(() => {
      if (changedOrigin === null) {
        log("🔄 全局配置变更，全部重排...");
        fullReload(server);
      } else {
        log(`🔄 ${changedOrigin} 变更，部分重排...`);
        partialReload(changedOrigin, server);
      }
    }, 100);
  });
}
