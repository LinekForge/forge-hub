/**
 * asr.ts — resolveAsr routing logic tests
 *
 * resolveAsr has five branches:
 *   1. override === "none"  → null
 *   2. no override + plugin has asrTranscribe → calls plugin
 *   3. plugin asrTranscribe throws → returns null (no fallback to hook)
 *   4. override === "hook"  → skips plugin, falls to runAsrHook
 *   5. no plugin + no hook env → null
 *
 * runAsrHook is integration-only (spawns /bin/bash); we test resolveAsr's
 * routing by controlling getCurrentConfig() and channelPlugins.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { HubConfig } from "./types.js";
import { setCurrentConfig } from "./hub-state.js";
import { channelPlugins } from "./channel-registry.js";

// resolveAsr reads ASR_HOOK at module level from process.env.FORGE_HUB_ASR_HOOK.
// We clear it before importing so runAsrHook always returns null (no external process).
const savedAsrHook = process.env.FORGE_HUB_ASR_HOOK;
delete process.env.FORGE_HUB_ASR_HOOK;

// Dynamic import after env is cleared — module-level const captures empty string.
const { resolveAsr } = await import("./asr.js");

// Restore env for other test files (if any depend on it).
afterEach(() => {
  if (savedAsrHook !== undefined) {
    process.env.FORGE_HUB_ASR_HOOK = savedAsrHook;
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

function setConfig(overrides: Partial<HubConfig> = {}): void {
  setCurrentConfig({
    port: 9900,
    host: "127.0.0.1",
    primary_instance: "test",
    show_instance_tag: false,
    ...overrides,
  });
}

beforeEach(() => {
  channelPlugins.clear();
  setConfig();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("resolveAsr routing", () => {
  test("override 'none' returns null immediately", async () => {
    // Even if plugin has asrTranscribe, override "none" short-circuits.
    let called = false;
    channelPlugins.set("wechat", {
      send: async () => ({ success: true }),
      asrTranscribe: async () => { called = true; return "text"; },
    });
    setConfig({ asr_plugin_override: { wechat: "none" } });

    const result = await resolveAsr("wechat", "/tmp/fake.ogg");
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  test("no override + plugin with asrTranscribe → calls plugin", async () => {
    channelPlugins.set("telegram", {
      send: async () => ({ success: true }),
      asrTranscribe: async (path: string) => `transcribed:${path}`,
    });
    setConfig(); // no asr_plugin_override

    const result = await resolveAsr("telegram", "/tmp/voice.ogg");
    expect(result).toBe("transcribed:/tmp/voice.ogg");
  });

  test("plugin asrTranscribe throws → returns null, no fallback", async () => {
    channelPlugins.set("feishu", {
      send: async () => ({ success: true }),
      asrTranscribe: async () => { throw new Error("ASR provider down"); },
    });
    setConfig();

    const result = await resolveAsr("feishu", "/tmp/voice.ogg");
    expect(result).toBeNull();
  });

  test("override 'hook' skips plugin even if it has asrTranscribe", async () => {
    let pluginCalled = false;
    channelPlugins.set("wechat", {
      send: async () => ({ success: true }),
      asrTranscribe: async () => { pluginCalled = true; return "from-plugin"; },
    });
    setConfig({ asr_plugin_override: { wechat: "hook" } });

    // ASR_HOOK is empty (env cleared above) → runAsrHook returns null
    const result = await resolveAsr("wechat", "/tmp/voice.ogg");
    expect(result).toBeNull();
    expect(pluginCalled).toBe(false);
  });

  test("no plugin + no hook → returns null", async () => {
    // channelPlugins is empty, no hook env
    setConfig();

    const result = await resolveAsr("nonexistent", "/tmp/voice.ogg");
    expect(result).toBeNull();
  });

  test("plugin without asrTranscribe → falls through to hook (null when no hook)", async () => {
    channelPlugins.set("imessage", {
      send: async () => ({ success: true }),
      // no asrTranscribe
    });
    setConfig();

    const result = await resolveAsr("imessage", "/tmp/voice.caf");
    expect(result).toBeNull();
  });

  test("plugin asrTranscribe returning null is passed through", async () => {
    channelPlugins.set("telegram", {
      send: async () => ({ success: true }),
      asrTranscribe: async () => null,
    });
    setConfig();

    const result = await resolveAsr("telegram", "/tmp/empty.ogg");
    expect(result).toBeNull();
  });

  test("override on a different channel does not affect this channel", async () => {
    channelPlugins.set("telegram", {
      send: async () => ({ success: true }),
      asrTranscribe: async () => "telegram-asr",
    });
    // Override is for wechat, not telegram
    setConfig({ asr_plugin_override: { wechat: "none" } });

    const result = await resolveAsr("telegram", "/tmp/voice.ogg");
    expect(result).toBe("telegram-asr");
  });
});
