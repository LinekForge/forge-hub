/**
 * Forge Hub — Channel plugin registry (shared mutable state)
 *
 * channel-loader loads all plugins into these maps; the rest of the hub
 * (router / endpoints / lock broadcast / approval push) reads them.
 *
 * Exported as `const Map` so all importers share the same reference——main()
 * uses `populate()` (clear + re-add) after `loadChannels`, never reassigns
 * the binding. Callers should never mutate directly outside loader.
 */

import type { SendParams } from "./types.js";

export interface ChannelSendEntry {
  send: (p: SendParams) => Promise<{ success: boolean; error?: string }>;
  isNativeId?: (to: string) => boolean;
  /** Plugin 自带的 ASR（语音转文字）能力，可选。resolveAsr 会优先调这个。 */
  asrTranscribe?: (audioPath: string) => Promise<string | null>;
}

export interface ChannelMetaEntry {
  name: string;
  displayName: string;
  aliases: string[];
}

export const channelPlugins = new Map<string, ChannelSendEntry>();
export const channelPluginsMeta = new Map<string, ChannelMetaEntry>();

/** 用 loadChannels 的结果 (sendMap, metaMap) 填充 registry。清空旧再填新。 */
export function populate(
  sendMap: Map<string, ChannelSendEntry>,
  metaMap: Map<string, ChannelMetaEntry>,
): void {
  channelPlugins.clear();
  for (const [k, v] of sendMap) channelPlugins.set(k, v);
  channelPluginsMeta.clear();
  for (const [k, v] of metaMap) channelPluginsMeta.set(k, v);
}
