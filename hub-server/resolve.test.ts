import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Redirect state dir to a temp directory for test isolation
const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-resolve-test-"));
process.env.FORGE_HUB_DIR = hubDir;

import { getInstances } from "./instance-manager.js";
import { channelPlugins } from "./channel-registry.js";
import { filterBySubscription, resolveRecipient } from "./resolve.js";
import type { ConnectedInstance } from "./types.js";
import type { ChannelSendEntry } from "./channel-registry.js";

function makeInstance(id: string, overrides: Partial<ConnectedInstance> = {}): ConnectedInstance {
  return {
    id,
    connectedAt: new Date().toISOString(),
    ws: {} as ConnectedInstance["ws"],
    send() { return 1; },
    close() {},
    ...overrides,
  };
}

function writeAllowlist(channel: string, allowed: { id: string; nickname: string }[]) {
  const dir = path.join(hubDir, "state", channel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "allowlist.json"),
    JSON.stringify({ allowed, auto_allow_next: false }, null, 2),
  );
}

beforeEach(() => {
  getInstances().clear();
  channelPlugins.clear();
});

afterEach(() => {
  getInstances().clear();
  channelPlugins.clear();
  // Clean state files between tests
  const stateDir = path.join(hubDir, "state");
  if (fs.existsSync(stateDir)) fs.rmSync(stateDir, { recursive: true, force: true });
});

// ── filterBySubscription ──────────────────────────────────────────────────────

describe("filterBySubscription", () => {
  test("targeted=true filters out isChannel===false instances", () => {
    getInstances().set("ch-1", makeInstance("ch-1", { isChannel: true }));
    getInstances().set("tool-1", makeInstance("tool-1", { isChannel: false }));

    const result = filterBySubscription(["ch-1", "tool-1"], "wechat", true);

    expect(result).toEqual(["ch-1"]);
  });

  test("targeted=false, channels undefined = listen to all", () => {
    getInstances().set("ch-1", makeInstance("ch-1", { isChannel: true }));

    const result = filterBySubscription(["ch-1"], "telegram", false);

    expect(result).toEqual(["ch-1"]);
  });

  test("targeted=false, channels includes target = pass", () => {
    getInstances().set("ch-1", makeInstance("ch-1", { isChannel: true, channels: ["wechat", "telegram"] }));

    const result = filterBySubscription(["ch-1"], "wechat", false);

    expect(result).toEqual(["ch-1"]);
  });

  test("targeted=false, channels doesn't include target = filtered", () => {
    getInstances().set("ch-1", makeInstance("ch-1", { isChannel: true, channels: ["telegram"] }));

    const result = filterBySubscription(["ch-1"], "wechat", false);

    expect(result).toEqual([]);
  });

  test("targeted=false, isChannel===false = filtered", () => {
    getInstances().set("tool-1", makeInstance("tool-1", { isChannel: false }));

    const result = filterBySubscription(["tool-1"], "wechat", false);

    expect(result).toEqual([]);
  });
});

// ── resolveRecipient ──────────────────────────────────────────────────────────

describe("resolveRecipient", () => {
  test("plugin has isNativeId returning true → ok with raw id", () => {
    const plugin: ChannelSendEntry = {
      send: async () => ({ success: true }),
      isNativeId: (to) => to.startsWith("native_"),
    };
    channelPlugins.set("mychannel", plugin);

    const result = resolveRecipient("mychannel", "native_12345");

    expect(result).toEqual({ ok: true, id: "native_12345" });
  });

  test("fallback: @im.wechat format → native", () => {
    // No plugin registered — falls through to global fallback regex
    const result = resolveRecipient("wechat", "wxid_abc123@im.wechat");

    expect(result).toEqual({ ok: true, id: "wxid_abc123@im.wechat" });
  });

  test("fallback: pure digits 5+ → native", () => {
    const result = resolveRecipient("telegram", "123456789");

    expect(result).toEqual({ ok: true, id: "123456789" });
  });

  test("nickname single match → ok", () => {
    writeAllowlist("wechat", [
      { id: "wxid_alice@im.wechat", nickname: "Alice" },
      { id: "wxid_bob@im.wechat", nickname: "Bob" },
    ]);

    const result = resolveRecipient("wechat", "Alice");

    expect(result).toEqual({ ok: true, id: "wxid_alice@im.wechat" });
  });

  test("nickname zero match → error", () => {
    writeAllowlist("wechat", [
      { id: "wxid_alice@im.wechat", nickname: "Alice" },
    ]);

    const result = resolveRecipient("wechat", "Charlie");

    expect(result).toEqual({
      ok: false,
      error: `找不到联系人 "Charlie"（wechat allowlist 中无此昵称）`,
    });
  });

  test("nickname ambiguous → error", () => {
    writeAllowlist("telegram", [
      { id: "tg_111", nickname: "Sam" },
      { id: "tg_222", nickname: "Sam" },
    ]);

    const result = resolveRecipient("telegram", "Sam");

    expect(result).toEqual({
      ok: false,
      error: `昵称 "Sam" 有歧义，匹配到 2 个: tg_111, tg_222。请用完整 ID`,
    });
  });
});
