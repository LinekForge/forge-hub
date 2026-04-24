/**
 * 配置加载 + 热加载
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CONFIG_FILE,
  SCHEDULE_DIR,
  STATE_DIR,
  DIR,
  log,
  logError,
} from "./config.js";
import type {
  ForgeConfig,
  RawScheduleEntry,
  ScheduleFile,
  ContactChannel,
} from "./types.js";

// ── Config Hashes (for change detection) ────────────────────────────────────

const configHashes = new Map<string, string>();

function fileHash(filePath: string): string {
  try {
    return crypto
      .createHash("md5")
      .update(fs.readFileSync(filePath, "utf-8"))
      .digest("hex");
  } catch {
    return "";
  }
}

function hasChanged(filePath: string): boolean {
  const newHash = fileHash(filePath);
  const oldHash = configHashes.get(filePath);

  // File deleted: had a hash before, now empty
  if (!newHash && oldHash) {
    configHashes.delete(filePath);
    return true;
  }
  // File doesn't exist and never did
  if (!newHash) return false;
  // Content unchanged
  if (oldHash === newHash) return false;
  // Content changed or new file
  configHashes.set(filePath, newHash);
  return true;
}

// ── Ensure Directories ──────────────────────────────────────────────────────

export function ensureDirs(): void {
  for (const dir of [DIR, SCHEDULE_DIR, STATE_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* ignore unsupported chmod */ }
  }
}

// ── Init Default Config ─────────────────────────────────────────────────────

export function initDefaultConfig(): void {
  if (fs.existsSync(CONFIG_FILE)) return;

  const defaultConfig: ForgeConfig = {
    enabled: true,
    scan_dir: true,
    contacts: {},
  };

  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify(defaultConfig, null, 2),
    "utf-8",
  );
  log("生成默认 engine-config.json（编辑 contacts 添加联系人）");
}

// ── Load Config ─────────────────────────────────────────────────────────────

export function loadForgeConfig(): ForgeConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      configHashes.set(CONFIG_FILE, fileHash(CONFIG_FILE));
      return config;
    }
  } catch (err) {
    logError(`读取 engine-config.json 失败: ${String(err)}`);
  }
  return { enabled: true, scan_dir: true, contacts: {} };
}

// ── Load Schedule Dir ───────────────────────────────────────────────────────

export function loadScheduleDir(): RawScheduleEntry[] {
  const entries: RawScheduleEntry[] = [];

  try {
    if (!fs.existsSync(SCHEDULE_DIR)) return entries;

    const files = fs
      .readdirSync(SCHEDULE_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();

    for (const file of files) {
      const filePath = path.join(SCHEDULE_DIR, file);
      try {
        const data: ScheduleFile = JSON.parse(
          fs.readFileSync(filePath, "utf-8"),
        );
        for (const [index, entry] of (data.schedules ?? []).entries()) {
          entry._origin = file;
          entry._entry_index = index;
          entries.push(entry);
        }
        configHashes.set(filePath, fileHash(filePath));
      } catch (err) {
        logError(`读取 ${file} 失败: ${String(err)}`);
      }
    }
  } catch (err) {
    logError(`扫描 engine.d/ 失败: ${String(err)}`);
  }

  return entries;
}

// ── Format Contacts ─────────────────────────────────────────────────────────

export function formatContacts(
  contacts: Record<string, Record<string, ContactChannel>>,
): string {
  const lines: string[] = ["可用通道："];

  for (const [name, channels] of Object.entries(contacts)) {
    for (const [channelName, info] of Object.entries(channels)) {
      lines.push(
        `- ${channelName}: 使用 ${info.tool} 工具，sender_id = "${info.sender_id}"`,
      );
    }
  }

  return lines.join("\n");
}

// ── Get primary sender_id ───────────────────────────────────────────────────

export function getPrimarySenderId(
  contacts: Record<string, Record<string, ContactChannel>>,
): string {
  for (const channels of Object.values(contacts)) {
    for (const info of Object.values(channels)) {
      return info.sender_id;
    }
  }
  return "";
}

// ── Config Watcher ──────────────────────────────────────────────────────────

export function startConfigWatcher(
  onReload: (changedOrigin: string | null) => void,
): void {
  // Watch engine-config.json → null means global config changed, full reload
  try {
    fs.watch(DIR, (_event, filename) => {
      if (!filename || filename !== "engine-config.json") return;
      if (!hasChanged(CONFIG_FILE)) return;
      log("🔄 hot-reload: engine-config.json 已变更");
      onReload(null);
    });
  } catch (err) {
    logError(`fs.watch DIR 失败: ${String(err)}`);
  }

  // Watch engine.d/ → pass changed filename so scheduler only re-schedules that origin
  try {
    fs.watch(SCHEDULE_DIR, (_event, filename) => {
      if (!filename || !filename.endsWith(".json")) return;
      const filePath = path.join(SCHEDULE_DIR, filename);
      if (!hasChanged(filePath)) return;
      log(`🔄 hot-reload: engine.d/${filename} 已变更`);
      onReload(filename);
    });
  } catch (err) {
    logError(`fs.watch engine.d/ 失败: ${String(err)}`);
  }

  log("👁 fs.watch: 监听配置变更");
}
