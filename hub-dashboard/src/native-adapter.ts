import type { NativeSession } from "./native-bridge";
import type { DesignAI } from "./adapter";

const SHAPES = ["bloom", "ripple", "prism", "moss", "default"];

function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function ago(ts: number): string {
  const ms = Date.now() - ts * 1000;
  if (ms < 60_000) return "刚刚";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}分钟前`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}小时前`;
  return `${Math.floor(ms / 86400_000)}天前`;
}

function sessionUptime(ts: number): string {
  const ms = Date.now() - ts * 1000;
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return `${h}h ${m}m`;
}

export function adaptNativeSession(s: NativeSession, index: number): DesignAI {
  const name = s.description || s.hubDesc || s.display;
  const alias = s.tag || s.hubTag || null;

  return {
    id: s.sid,
    name: name || s.display,
    alias,
    role: "",
    isChannel: s.isChannel ?? false,
    status: s.isActive ? "online" : "offline",
    statusText: s.isActive
      ? (s.isChannel ? "在线" : "在线 · 仅工具")
      : "离线",
    mood: "calm",
    uptime: s.isActive ? sessionUptime(s.timestamp) : "—",
    channels: s.channels ?? [],
    seed: hashSeed(s.sid),
    shape: SHAPES[index % SHAPES.length],
    lastMessageAt: ago(s.timestamp),
  };
}
