import fs from "node:fs";
import path from "node:path";

export interface SessionConfig {
  tag?: string;
  description?: string;
  channels?: string[];
  history?: Record<string, number>;
  /**
   * Distinguishes channel mode (receives messages via WebSocket) from tool mode (send only).
   * Set by next-session.json (launcher) or inferred from channels array.
   * NOT restored from crash recovery — isChannel is per-session, determined by CC's
   * --dangerously-load-development-channels flag, not by historical identity records.
   */
  isChannel?: boolean;
}

export interface SessionConfigPaths {
  sessionFile: string;
  legacyNameFile: string;
  identitiesFile: string;
}

type LogError = (msg: string) => void;

const LEGACY_ALIASES: Record<string, string> = {
  wx: "wechat",
  tg: "telegram",
  im: "imessage",
  fs: "feishu",
};

export function getSessionConfigPaths(hubDir: string): SessionConfigPaths {
  return {
    sessionFile: path.join(hubDir, "next-session.json"),
    legacyNameFile: path.join(hubDir, "next-name.txt"),
    identitiesFile: path.join(hubDir, "state", "_hub", "instance-identities.json"),
  };
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeChannels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const channels = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  return channels.length > 0 ? channels : undefined;
}

function normalizeHistory(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entries = Object.entries(value).filter(
    ([key, count]) => key.length > 0 && typeof count === "number" && Number.isFinite(count) && count >= 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeExplicitSessionConfig(raw: unknown): SessionConfig | null {
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  const channels = normalizeChannels(obj.channels);
  const isChannel = typeof obj.isChannel === "boolean"
    ? obj.isChannel
    : hasOwn(obj, "channels") && Array.isArray(obj.channels) && obj.channels.length > 0;

  const config: SessionConfig = {
    tag: typeof obj.tag === "string" && obj.tag.length > 0 ? obj.tag : undefined,
    description: typeof obj.description === "string" && obj.description.length > 0 ? obj.description : undefined,
    channels,
    history: normalizeHistory(obj.history),
    isChannel,
  };

  return config;
}

function parseLegacySessionConfig(raw: string): SessionConfig | null {
  if (!raw) return null;

  const parts = raw.split(",");
  const tag = parts[0]?.trim() || undefined;
  const description = parts[1]?.trim() || undefined;
  const channelsRaw = parts[2]?.trim();
  const isChannel = Boolean(channelsRaw);
  const channels = channelsRaw && channelsRaw !== "all"
    ? channelsRaw.split("+").map((channel) => LEGACY_ALIASES[channel.toLowerCase()] ?? channel.toLowerCase())
    : undefined;

  return { tag, description, channels, isChannel };
}

export function isChannelMode(config: SessionConfig | null | undefined): boolean {
  return Boolean(config?.isChannel);
}

export function readAndClearSessionConfig(
  paths: SessionConfigPaths,
  instanceId: string,
  logError: LogError,
): SessionConfig | null {
  // 1. Try new JSON format (launcher / manual config)
  try {
    if (fs.existsSync(paths.sessionFile)) {
      const parsed = normalizeExplicitSessionConfig(JSON.parse(fs.readFileSync(paths.sessionFile, "utf-8")));
      fs.unlinkSync(paths.sessionFile);
      return parsed;
    }
  } catch (err) {
    logError(`session config layer 1 (next-session.json) 读失败: ${String(err)}`);
  }

  // 2. Fallback to legacy comma-separated format
  try {
    if (fs.existsSync(paths.legacyNameFile)) {
      const parsed = parseLegacySessionConfig(fs.readFileSync(paths.legacyNameFile, "utf-8").trim());
      fs.unlinkSync(paths.legacyNameFile);
      return parsed;
    }
  } catch (err) {
    logError(`session config layer 2 (legacy next-name.txt) 读失败: ${String(err)}`);
  }

  // 3. Crash recovery — restore tag/description but NOT isChannel.
  // isChannel 由 CC 的 --dangerously-load-development-channels flag 决定（per-session），
  // 不应从历史记录继承——否则 PID 重用会让 tools 窗口误进 channel 模式。
  try {
    if (fs.existsSync(paths.identitiesFile)) {
      const all = JSON.parse(fs.readFileSync(paths.identitiesFile, "utf-8")) as Record<string, Record<string, unknown>>;
      const saved = all[instanceId];
      if (saved && (typeof saved.tag === "string" || typeof saved.description === "string")) {
        return {
          tag: typeof saved.tag === "string" ? saved.tag : undefined,
          description: typeof saved.description === "string" ? saved.description : undefined,
        };
      }
    }
  } catch (err) {
    logError(`session config layer 3 (instance-identities.json) 读失败: ${String(err)}`);
  }

  // No session config found — caller should detect channel handler before deciding.
  return null;
}
