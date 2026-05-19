/**
 * Forge Hub — 消息投递队列
 *
 * 当入站消息无法投递（无在线实例 / WebSocket 推送失败）时入队。
 * 实例上线后 drain 队列，确保消息不丢。
 *
 * 存储：SQLite WAL，24 小时自动过期。
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import { HUB_DIR, log, logError } from "./config.js";

let db: Database | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
const DB_PATH = path.join(HUB_DIR, "queue.db");

export function initQueue(): void {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
    db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_pending_channel ON pending(channel)");
    db.run("DELETE FROM pending WHERE created_at < datetime('now', '-24 hours')");
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.chmodSync(DB_PATH + suffix, 0o600); } catch { /* chmod best-effort */ }
    }
    const count = (db.prepare("SELECT COUNT(*) as n FROM pending").get() as { n: number }).n;
    if (count > 0) log(`📬 消息队列: ${count} 条待投递`);
    cleanupTimer = setInterval(() => {
      try { db?.run("DELETE FROM pending WHERE created_at < datetime('now', '-24 hours')"); } catch (err) { logError(`队列过期清理失败: ${String(err)}`); }
    }, 3600_000);
  } catch (err) {
    logError(`消息队列初始化失败: ${String(err)}`);
    db = null;
  }
}

export function enqueue(channel: string, payload: Record<string, unknown>): void {
  if (!db) return;
  try {
    db.run(
      "INSERT INTO pending (channel, payload) VALUES (?, ?)",
      [channel, JSON.stringify(payload)],
    );
  } catch (err) {
    logError(`消息入队失败: ${String(err)}`);
  }
}

export interface QueuedMessage {
  id: number;
  channel: string;
  payload: Record<string, unknown>;
}

export function drain(channels: string[], limit = 50): QueuedMessage[] {
  if (!db || channels.length === 0) return [];
  try {
    const placeholders = channels.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, channel, payload FROM pending WHERE channel IN (${placeholders}) ORDER BY id LIMIT ?`
    ).all(...channels, limit) as { id: number; channel: string; payload: string }[];
    return rows.map(r => ({ id: r.id, channel: r.channel, payload: JSON.parse(r.payload) as Record<string, unknown> }));
  } catch (err) {
    logError(`消息出队失败: ${String(err)}`);
    return [];
  }
}

export function dequeue(ids: number[]): void {
  if (!db || ids.length === 0) return;
  try {
    const placeholders = ids.map(() => "?").join(",");
    db.run(`DELETE FROM pending WHERE id IN (${placeholders})`, ids);
  } catch (err) {
    logError(`消息删除失败: ${String(err)}`);
  }
}

export function queueSize(): number {
  if (!db) return 0;
  try {
    return (db.prepare("SELECT COUNT(*) as n FROM pending").get() as { n: number }).n;
  } catch { return 0; }
}

export function closeQueue(): void {
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null; }
  if (db) { db.close(); db = null; }
}
