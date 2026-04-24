export interface Instance {
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

export interface ChannelHealth {
  loaded: boolean;
  health_status: string;
  messagesIn: number;
  messagesOut: number;
  errors: number;
  consecutiveFailures: number;
  lastMessageIn?: string;
  lastMessageOut?: string;
  lastError?: string;
}

export interface Message {
  id: string;
  ts: string;
  direction: "in" | "out";
  from: string;
  text: string;
  channel?: string;
  syncStatus?: "sending" | "sent" | "failed";
  fanoutResults?: { channel: string; ok: boolean; error?: string }[];
}

export interface HistoryItem {
  ts: string;
  direction: "in" | "out";
  from: string;
  text: string;
}

export interface PendingApproval {
  request_id: string;
  yes_id: string;
  no_id: string;
  tool_name: string;
  description: string;
  from_instance: string;
  waited_seconds: number;
  remaining_seconds: number;
  pushed_channels?: string[];
}

export interface ChannelInfo {
  id: string;
  name: string;
  aliases: string[];
  health?: ChannelHealth;
}

export interface HubInfo {
  version: string;
  uptime: number;
  memory_mb: number;
  pid?: number;
  started_at: string;
  locked: boolean;
}

export interface OverviewData {
  instances: Instance[];
  channels: Record<string, ChannelHealth>;
  pending: PendingApproval[];
  hub: HubInfo;
}
