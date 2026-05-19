import { describe, expect, test } from "bun:test";

import {
  channelPlugins,
  channelPluginsMeta,
  populate,
  type ChannelMetaEntry,
  type ChannelSendEntry,
} from "./channel-registry.js";

describe("channel-registry", () => {
  test("populate fills channelPlugins and channelPluginsMeta", () => {
    const sendMap = new Map<string, ChannelSendEntry>();
    const metaMap = new Map<string, ChannelMetaEntry>();

    sendMap.set("tg", { send: async () => ({ success: true }) });
    metaMap.set("tg", {
      name: "tg",
      displayName: "Telegram",
      aliases: ["telegram"],
    });

    populate(sendMap, metaMap);

    expect(channelPlugins.has("tg")).toBe(true);
    expect(channelPlugins.get("tg")!.send).toBeFunction();
    expect(channelPluginsMeta.get("tg")!.displayName).toBe("Telegram");
  });

  test("populate clears old entries on re-call", () => {
    const sendMap1 = new Map<string, ChannelSendEntry>();
    const metaMap1 = new Map<string, ChannelMetaEntry>();
    sendMap1.set("old", { send: async () => ({ success: true }) });
    metaMap1.set("old", { name: "old", displayName: "Old", aliases: [] });

    populate(sendMap1, metaMap1);
    expect(channelPlugins.has("old")).toBe(true);
    expect(channelPluginsMeta.has("old")).toBe(true);

    const sendMap2 = new Map<string, ChannelSendEntry>();
    const metaMap2 = new Map<string, ChannelMetaEntry>();
    sendMap2.set("new", { send: async () => ({ success: true }) });
    metaMap2.set("new", { name: "new", displayName: "New", aliases: [] });

    populate(sendMap2, metaMap2);

    expect(channelPlugins.has("old")).toBe(false);
    expect(channelPluginsMeta.has("old")).toBe(false);
    expect(channelPlugins.has("new")).toBe(true);
    expect(channelPluginsMeta.has("new")).toBe(true);
  });

  test("channelPlugins and channelPluginsMeta are independent Maps", () => {
    // Populate with a key only in sendMap, not in metaMap, and vice versa
    const sendMap = new Map<string, ChannelSendEntry>();
    const metaMap = new Map<string, ChannelMetaEntry>();

    sendMap.set("send-only", { send: async () => ({ success: true }) });
    metaMap.set("meta-only", {
      name: "meta-only",
      displayName: "Meta Only",
      aliases: [],
    });

    populate(sendMap, metaMap);

    expect(channelPlugins.has("send-only")).toBe(true);
    expect(channelPlugins.has("meta-only")).toBe(false);
    expect(channelPluginsMeta.has("meta-only")).toBe(true);
    expect(channelPluginsMeta.has("send-only")).toBe(false);

    // Also verify they are distinct object references
    expect(channelPlugins).not.toBe(channelPluginsMeta);
  });

  test("formatHints stored in metaMap", () => {
    const sendMap = new Map<string, ChannelSendEntry>();
    const metaMap = new Map<string, ChannelMetaEntry>();

    sendMap.set("wx", { send: async () => ({ success: true }) });
    metaMap.set("wx", {
      name: "wx",
      displayName: "WeChat",
      aliases: ["wechat"],
      formatHints: "Plain text only. No Markdown.",
    });

    sendMap.set("tg", { send: async () => ({ success: true }) });
    metaMap.set("tg", {
      name: "tg",
      displayName: "Telegram",
      aliases: [],
      formatHints: "Supports MarkdownV2.",
    });

    sendMap.set("bare", { send: async () => ({ success: true }) });
    metaMap.set("bare", {
      name: "bare",
      displayName: "Bare",
      aliases: [],
      // no formatHints
    });

    populate(sendMap, metaMap);

    expect(channelPluginsMeta.get("wx")!.formatHints).toBe(
      "Plain text only. No Markdown.",
    );
    expect(channelPluginsMeta.get("tg")!.formatHints).toBe(
      "Supports MarkdownV2.",
    );
    expect(channelPluginsMeta.get("bare")!.formatHints).toBeUndefined();
  });
});
