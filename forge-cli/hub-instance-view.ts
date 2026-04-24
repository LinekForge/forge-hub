export interface HubInstanceView {
  id: string;
  tag?: string;
  description?: string;
  isChannel?: boolean;
  channels?: string[];
  presence?: "live" | "known";
  connectedAt?: string;
  lastSeenAt?: string;
  summary?: string;
}

export function getInstancePresence(instance: HubInstanceView): "live" | "known" {
  if (instance.presence === "live" || instance.presence === "known") return instance.presence;
  return instance.connectedAt ? "live" : "known";
}

export function partitionInstances(instances: HubInstanceView[]): {
  live: HubInstanceView[];
  known: HubInstanceView[];
} {
  const live: HubInstanceView[] = [];
  const known: HubInstanceView[] = [];

  for (const instance of instances) {
    if (getInstancePresence(instance) === "live") {
      live.push(instance);
    } else {
      known.push(instance);
    }
  }

  return { live, known };
}

export function formatInstanceName(instance: HubInstanceView): string {
  return instance.description ?? instance.tag ?? instance.id;
}

export function formatInstanceTag(instance: HubInstanceView): string {
  return instance.tag ? ` @${instance.tag}` : "";
}

export function formatInstanceLabel(instance: HubInstanceView): string {
  const desc = instance.description ? `${instance.description}` : "";
  const tag = instance.tag ?? "";
  if (desc && tag) return ` (${desc}@${tag})`;
  if (desc) return ` (${desc})`;
  if (tag) return ` (@${tag})`;
  return "";
}

export function formatInstanceChannels(instance: HubInstanceView): string {
  return instance.channels ? instance.channels.join(", ") : "all";
}

export function timeSince(iso: string, now = Date.now()): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "未知";
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 60) return `${sec}s前`;
  if (sec < 3600) return `${Math.round(sec / 60)}m前`;
  return `${Math.round(sec / 3600)}h前`;
}

export function formatKnownState(instance: HubInstanceView, now = Date.now()): string {
  const parts = [instance.isChannel === false ? "仅工具" : "离线"];
  if (instance.lastSeenAt) {
    parts.push(`上次出现 ${timeSince(instance.lastSeenAt, now)}`);
  }
  return parts.join(" · ");
}
