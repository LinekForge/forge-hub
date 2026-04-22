/**
 * Forge Hub — 统一聊天历史
 *
 * 每通道一份 jsonl: ~/.forge-hub/state/{channel}/chat-history.jsonl
 * 每行 JSON: { ts, direction: "in" | "out", from, text }
 *
 * in  = 从通道收到的消息（通道层 append）
 * out = Hub 发出的消息（send handler append）
 */

import fs from "node:fs";
import { HUB_DIR, logError, recordOutbound } from "./config.js";
import { getInstances } from "./instance-manager.js";
import { enqueueAppend } from "./write-queue.js";

export interface HistoryEntry {
  ts: string;
  [key: string]: unknown;
}

function historyFilePath(channel: string): string {
  return `${HUB_DIR}/state/${channel}/chat-history.jsonl`;
}

export function appendHistory(channel: string, direction: "in" | "out", from: string, text: string): void {
  if (direction === "out") recordOutbound(channel);
  const entry = JSON.stringify({ ts: new Date().toISOString(), direction, from, text });
  enqueueAppend(historyFilePath(channel), entry + "\n", {
    dirMode: 0o700,
    fileMode: 0o600,
    onError: (err) => { logError(`历史写入失败 (${channel}): ${String(err)}`); },
  });
}

export async function readRecentHistory(channel: string, limit: number, sinceTs?: string): Promise<HistoryEntry[]> {
  return await readRecentHistoryFile(historyFilePath(channel), limit, sinceTs);
}

export async function readRecentHistoryFile(
  filePath: string,
  limit: number,
  sinceTs?: string,
): Promise<HistoryEntry[]> {
  if (limit <= 0) return [];

  let file: fs.promises.FileHandle | null = null;
  try {
    file = await fs.promises.open(filePath, "r");
    const stat = await file.stat();
    if (stat.size <= 0) return [];

    const chunkSize = 64 * 1024;
    let position = stat.size;
    let remainder = "";
    const entries: HistoryEntry[] = [];

    const pushLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const entry = JSON.parse(trimmed) as HistoryEntry;
        if (sinceTs && (typeof entry.ts !== "string" || entry.ts <= sinceTs)) return;
        entries.push(entry);
      } catch {}
    };

    while (position > 0 && entries.length < limit) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await file.read(buffer, 0, readSize, position);
      const chunk = buffer.toString("utf-8", 0, bytesRead);
      const combined = chunk + remainder;
      const parts = combined.split("\n");
      remainder = parts.shift() ?? "";
      for (let i = parts.length - 1; i >= 0 && entries.length < limit; i--) {
        pushLine(parts[i]);
      }
    }

    if (entries.length < limit && remainder) {
      pushLine(remainder);
    }

    return entries.reverse();
  } catch (err) {
    if (String(err).includes("ENOENT")) return [];
    throw err;
  } finally {
    await file?.close();
  }
}

/**
 * 出站消息的 from 字段——多实例场景下 disambiguate，单实例直接 "Forge"。
 * Users can override via HUB_AGENT_NAME env or config (TODO).
 */
export function getOutboundFrom(instanceId: string | undefined): string {
  const DEFAULT_NAME = "Forge";
  if (!instanceId) return DEFAULT_NAME;
  const instances = getInstances();
  const inst = instances.get(instanceId);
  if (!inst) return DEFAULT_NAME;
  if (instances.size <= 1) return DEFAULT_NAME;
  if (inst.description && inst.tag) return `${DEFAULT_NAME} (${inst.description}@${inst.tag})`;
  if (inst.description) return `${DEFAULT_NAME} (${inst.description})`;
  if (inst.tag) return `${DEFAULT_NAME} (@${inst.tag})`;
  return DEFAULT_NAME;
}
