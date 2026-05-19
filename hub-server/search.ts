/**
 * Forge Hub — FTS5 全文搜索索引（可选）
 *
 * 在 appendHistory 的同时写入 SQLite FTS5 虚拟表，提供毫秒级关键字搜索。
 * 通过 hub-config.json 的 search_index: true 启用（默认关闭）。
 *
 * Schema: messages(ts TEXT, channel TEXT, direction TEXT, sender TEXT, content TEXT)
 * FTS5 虚拟表: messages_fts(content, sender) 使用 trigram tokenizer 支持中文。
 */

import { Database } from "bun:sqlite";
import path from "node:path";
import fs from "node:fs";
import { HUB_DIR, logError } from "./config.js";

let db: Database | null = null;

const DB_PATH = path.join(HUB_DIR, "search.db");

export function isSearchEnabled(): boolean {
  return db !== null;
}

export function initSearch(enabled: boolean): void {
  if (!enabled) return;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
    db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        channel TEXT NOT NULL,
        direction TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content, sender,
        content='messages',
        content_rowid='id',
        tokenize='trigram'
      )
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content, sender) VALUES (new.id, new.content, new.sender);
      END
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_channel_ts ON messages(channel, ts)
    `);
    // WAL/SHM 文件权限跟随 db 文件，防止 umask 宽松时泄漏
    for (const suffix of ["", "-wal", "-shm"]) {
      try { fs.chmodSync(DB_PATH + suffix, 0o600); } catch { /* chmod best-effort */ }
    }
  } catch (err) {
    logError(`search index 初始化失败: ${String(err)}`);
    db = null;
  }
}

export function indexMessage(channel: string, direction: "in" | "out", sender: string, content: string): void {
  if (!db) return;
  try {
    db.run(
      "INSERT INTO messages (ts, channel, direction, sender, content) VALUES (?, ?, ?, ?, ?)",
      [new Date().toISOString(), channel, direction, sender, content],
    );
  } catch (err) {
    logError(`search index 写入失败: ${String(err)}`);
  }
}

export interface SearchResult {
  ts: string;
  channel: string;
  direction: string;
  sender: string;
  content: string;
}

export function searchHistory(
  query: string,
  options?: { channel?: string; limit?: number; sinceTs?: string },
): SearchResult[] {
  if (!db) return [];
  const limit = options?.limit ?? 20;
  try {
    let sql = `
      SELECT m.ts, m.channel, m.direction, m.sender, m.content
      FROM messages m
      JOIN messages_fts f ON f.rowid = m.id
      WHERE messages_fts MATCH ?
    `;
    const params: (string | number)[] = [query];
    if (options?.channel) {
      sql += " AND m.channel = ?";
      params.push(options.channel);
    }
    if (options?.sinceTs) {
      sql += " AND m.ts >= ?";
      params.push(options.sinceTs);
    }
    sql += " ORDER BY m.ts DESC LIMIT ?";
    params.push(limit);
    return db.prepare(sql).all(...params) as SearchResult[];
  } catch (err) {
    logError(`search query 失败: ${String(err)}`);
    return [];
  }
}

export function closeSearch(): void {
  if (db) {
    db.close();
    db = null;
  }
}
