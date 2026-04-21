/**
 * Forge Engine 路径常量与日志
 */

import path from "node:path";

// ── Channel Identity ────────────────────────────────────────────────────────

export const CHANNEL_NAME = "engine";
export const CHANNEL_VERSION = "0.1.0";

// ── Paths ───────────────────────────────────────────────────────────────────

export const DIR = path.join(
  process.env.HOME || "~",
  ".claude",
  "channels",
  "engine",
);

export const CONFIG_FILE = path.join(DIR, "engine-config.json");
export const SCHEDULE_DIR = path.join(DIR, "engine.d");
export const STATE_DIR = path.join(DIR, "engine-state");
export const HANDLERS_DIR = path.resolve(
  import.meta.dir,
  "handlers",
);
export const SCHEDULE_FILE = path.join(DIR, "engine-schedule.json");
export const ACTION_LOG_FILE = path.join(DIR, "engine-trigger-log.md");
export const PID_FILE = path.join(DIR, "engine.pid");

// ── Logging (stderr — stdout is MCP stdio) ──────────────────────────────────

export function log(msg: string) {
  process.stderr.write(`[engine] ${msg}\n`);
}

export function logError(msg: string) {
  process.stderr.write(`[engine] ERROR: ${msg}\n`);
}
