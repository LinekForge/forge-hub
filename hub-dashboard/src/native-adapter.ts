import type { NativeSession } from "./native-bridge";
import type { DesignAI } from "./adapter";

export function groupNativeSessions(sessions: NativeSession[]): { starred: NativeSession[]; groups: { label: string; sessions: NativeSession[] }[] } {
  const starred = sessions.filter(s => s.isStarred);
  const rest = sessions.filter(s => !s.isStarred);

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
  const yesterdayStart = todayStart - 86400;

  const grouped = new Map<string, NativeSession[]>();
  for (const s of rest) {
    let label: string;
    if (s.timestamp >= todayStart) label = '今天';
    else if (s.timestamp >= yesterdayStart) label = '昨天';
    else {
      const d = new Date(s.timestamp * 1000);
      label = `${d.getMonth() + 1}月${d.getDate()}日`;
    }
    if (!grouped.has(label)) grouped.set(label, []);
    grouped.get(label)!.push(s);
  }

  return { starred, groups: [...grouped.entries()].map(([label, sessions]) => ({ label, sessions })) };
}

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
    isChannel: s.isActive ? (s.isChannel ?? false) : false,
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
