// Adapter: Hub API data → Claude Design component data format

import type { Instance, ChannelHealth } from "./types";

// Design expects this shape for AI contacts
export interface DesignAI {
  id: string;
  name: string;
  alias: string | null;
  role: string;
  isChannel: boolean;
  status: "online" | "idle" | "offline";
  statusText: string;
  mood: string;
  uptime: string;
  channels: string[];
  seed: number;
  shape: string;
  lastMessageAt: string;
}

// Design expects this shape for channels
export interface DesignChannel {
  id: string;
  name: string;
  health: string;
  latencyLabel: string;
  inbound24h: number;
  outbound24h: number;
  errors1h: number;
  flowSummary: string;
  icon: string;
}

// Design expects this shape for approvals
export interface DesignApproval {
  id: string;
  ai: string;
  tool: string;
  intent: string;
  command: string;
  risk: "low" | "medium" | "high" | "unknown";
  requestedAt: string;
  time: string;
}

const SHAPES = ["bloom", "ripple", "prism", "moss", "default"];

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function formatUptime(connectedAt?: string): string {
  if (!connectedAt) return "—";
  const ms = Date.now() - new Date(connectedAt).getTime();
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

function ago(isoStr?: string): string {
  if (!isoStr) return "—";
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 60_000) return "刚刚";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}分钟前`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}小时前`;
  return `${Math.floor(ms / 86400_000)}天前`;
}

export function adaptInstance(inst: Instance, index: number): DesignAI {
  const name = inst.description || inst.tag || inst.id.slice(0, 10);
  const isChannel = inst.isChannel !== false;
  return {
    id: inst.id,
    name: name.split(/[·\-_]/)[0].trim(),
    alias: name.includes("·") ? name.split("·")[1]?.trim() ?? null : inst.tag ?? null,
    role: inst.summary || "",
    isChannel,
    status: isChannel ? (inst.connectedAt ? "online" : "offline") : "idle",
    statusText: isChannel
      ? (inst.summary || (inst.connectedAt ? "在线" : "离线"))
      : "仅工具 · 不接收消息",
    mood: "calm",
    uptime: formatUptime(inst.connectedAt),
    channels: inst.channels ?? [],
    seed: hashSeed(inst.id),
    shape: SHAPES[index % SHAPES.length],
    lastMessageAt: ago(inst.connectedAt),
  };
}

export function adaptChannel(id: string, health: ChannelHealth): DesignChannel {
  const names: Record<string, string> = { wechat: "微信", telegram: "Telegram", feishu: "飞书", imessage: "iMessage", homeland: "Homeland" };
  const lastInbound = ago(health.lastMessageIn);
  const lastOutbound = ago(health.lastMessageOut);
  return {
    id,
    name: names[id] || id,
    health: health.loaded === false ? "red"
      : health.health_status === "unhealthy" ? "red"
      : health.health_status === "degraded" ? "amber"
      : "green",
    latencyLabel: "—",
    inbound24h: health.messagesIn,
    outbound24h: health.messagesOut,
    errors1h: health.errors,
    flowSummary: `入 ${lastInbound} / 出 ${lastOutbound}`,
    icon: id,
  };
}

export function adaptApproval(a: { request_id: string; tool_name: string; description: string; from_instance: string; waited_seconds: number; remaining_seconds: number }): DesignApproval {
  return {
    id: a.request_id,
    ai: a.from_instance,
    tool: a.tool_name,
    intent: a.description,
    command: a.tool_name,
    risk: "unknown",
    requestedAt: `${Math.floor(a.waited_seconds / 60)} 分钟前`,
    time: ago(new Date(Date.now() - a.waited_seconds * 1000).toISOString()),
  };
}
