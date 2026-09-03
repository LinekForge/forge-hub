/**
 * Forge Engine 路径常量与日志
 */

import fs from "node:fs";
import path from "node:path";

// ── Channel Identity ────────────────────────────────────────────────────────

export const CHANNEL_NAME = "engine";
export const CHANNEL_VERSION = "0.1.0";

// ── Paths ───────────────────────────────────────────────────────────────────

const CODE_DIR = import.meta.dir;

const DATA_DIR = process.env.FORGE_ENGINE_DATA
  ?? path.join(process.env.HOME || "~", ".forge-hub", "engine-data");

export const DIR = DATA_DIR;

export const CONFIG_FILE = path.join(DATA_DIR, "engine-config.json");
export const SCHEDULE_DIR = path.join(DATA_DIR, "engine.d");
export const STATE_DIR = path.join(DATA_DIR, "engine-state");
export const HANDLERS_DIR = path.resolve(CODE_DIR, "handlers");
export const SCHEDULE_FILE = path.join(DATA_DIR, "engine-schedule.json");
export const ACTION_LOG_FILE = path.join(DATA_DIR, "engine-trigger-log.md");
export const PID_FILE = path.join(DATA_DIR, "engine.pid");
export const RUNTIME_LOG_FILE = path.join(DATA_DIR, "engine.log");

// ── Logging ─────────────────────────────────────────────────────────────────
//
// stderr 是给宿主看的（stdout 被 MCP stdio 占用）。但宿主只在**连接建立那一刻**
// 捕获 stderr —— engine 启动之后打印的任何东西都掉进黑洞。
//
// 后果实测（2026-09-03）：engine 在 00:00–03:00 之间死亡，无崩溃报告、无内存压力、
// 宿主日志里一条断开记录都没有，调度静默停摆 10 小时 31 分、漏跑 12 个任务。
// 它死之前很可能打印过原因，只是没人听见。
//
// 所以 log/logError 同时落盘。文件是唯一能在进程死后还留下痕迹的地方。

const MAX_LOG_BYTES = 2 * 1024 * 1024;   // 2MB 转存一次，只留一份 .1

function appendToFile(line: string): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // 轮转：日志本身不能变成下一个「不停长大且没人敢删」的文件
    try {
      if (fs.statSync(RUNTIME_LOG_FILE).size > MAX_LOG_BYTES) {
        fs.renameSync(RUNTIME_LOG_FILE, RUNTIME_LOG_FILE + ".1");
      }
    } catch { /* 文件还不存在 —— 首次写入，正常 */ }
    fs.appendFileSync(RUNTIME_LOG_FILE, line);
  } catch { /* 日志写不进去不能反过来把进程搞死 */ }
}

function stamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function log(msg: string) {
  process.stderr.write(`[engine] ${msg}\n`);
  appendToFile(`${stamp()} [engine] ${msg}\n`);
}

export function logError(msg: string) {
  process.stderr.write(`[engine] ERROR: ${msg}\n`);
  appendToFile(`${stamp()} [engine] ERROR: ${msg}\n`);
}

/** 致命错误：带完整堆栈落盘。进程即将退出时用。 */
export function logFatal(kind: string, err: unknown): void {
  // err.stack 本身已含 "Name: message" 首行，不要再拼一次
  const detail = err instanceof Error
    ? (err.stack ?? `${err.name}: ${err.message}\n(无堆栈)`)
    : String(err);
  const block = `${stamp()} [engine] FATAL ${kind} · PID ${process.pid}\n${detail}\n`;
  process.stderr.write(block);
  appendToFile(block);
}
