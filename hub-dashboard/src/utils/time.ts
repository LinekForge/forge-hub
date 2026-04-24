export function ago(isoStr: string | undefined): string {
  if (!isoStr) return "";
  const ms = Date.now() - new Date(isoStr).getTime();
  if (ms < 60_000) return "刚刚";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}分钟前`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}小时前`;
  return `${Math.floor(ms / 86400_000)}天前`;
}

export function shortTime(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
