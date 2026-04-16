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

export function appendHistory(channel: string, direction: "in" | "out", from: string, text: string): void {
  try {
    const dir = `${HUB_DIR}/state/${channel}`;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entry = JSON.stringify({ ts: new Date().toISOString(), direction, from, text });
    fs.appendFileSync(`${dir}/chat-history.jsonl`, entry + "\n", "utf-8");
    if (direction === "out") recordOutbound(channel);
  } catch (err) { logError(`历史写入失败 (${channel}): ${String(err)}`); }
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
