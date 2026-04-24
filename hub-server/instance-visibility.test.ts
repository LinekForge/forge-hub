import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-instance-tests-"));
process.env.FORGE_HUB_DIR = hubDir;

const { getInstances, listKnownInstances, setInstanceTag } = await import("./instance-manager.js");
const { loadChannelState, saveChannelState } = await import("./state.js");
import type { ConnectedInstance } from "./types.js";

function makeChannelInstance(id: string, description: string, channels?: string[]): ConnectedInstance {
  return {
    id,
    description,
    isChannel: true,
    channels,
    connectedAt: new Date().toISOString(),
    ws: {} as ConnectedInstance["ws"],
    send() { return 1; },
    close() {},
  };
}

function writeTestState(channel: string, key: string, data: unknown) {
  const dir = path.join(hubDir, "state", channel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.json`), JSON.stringify(data, null, 2));
}

beforeEach(() => {
  getInstances().clear();
  saveChannelState("_hub", "instance-identities", {});
});

afterAll(() => {
  fs.rmSync(hubDir, { recursive: true, force: true });
});

describe("listKnownInstances", () => {
  test("includes persisted tool-only instances and keeps channel listeners first", () => {
    const freshSeenAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const staleSeenAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    saveChannelState("_hub", "instance-identities", {
      "tool-1": { description: "Tool Worker", isChannel: false, lastSeenAt: freshSeenAt },
      "offline-channel": { description: "Offline Channel", isChannel: true, channels: ["wechat"], lastSeenAt: freshSeenAt },
      "stale-tool": { description: "Old Tool", isChannel: false, lastSeenAt: staleSeenAt },
    });
    getInstances().set("live-channel", makeChannelInstance("live-channel", "Live Channel", ["telegram"]));

    const instances = listKnownInstances();

    expect(instances.map((instance) => instance.id)).toEqual([
      "live-channel",
      "offline-channel",
      "tool-1",
    ]);
    expect(instances[0]).toMatchObject({
      id: "live-channel",
      isChannel: true,
      presence: "live",
      channels: ["telegram"],
    });
    expect(instances[1]).toMatchObject({
      id: "offline-channel",
      isChannel: true,
      presence: "known",
      lastSeenAt: freshSeenAt,
      channels: ["wechat"],
    });
    expect(instances[2]).toMatchObject({
      id: "tool-1",
      isChannel: false,
      presence: "known",
      lastSeenAt: freshSeenAt,
      description: "Tool Worker",
    });
  });

  test("backfills legacy channel identities but drops tool-only ghosts without lastSeenAt", () => {
    saveChannelState("_hub", "instance-identities", {
      "legacy-channel": { description: "Legacy Channel", isChannel: true, channels: ["wechat"] },
      "legacy-tool": { description: "Legacy Tool", isChannel: false },
    });

    const instances = listKnownInstances();
    const saved = loadChannelState("_hub", "instance-identities") as Record<string, { lastSeenAt?: string }>;

    expect(instances.map((instance) => instance.id)).toEqual(["legacy-channel"]);
    expect(saved["legacy-channel"]?.lastSeenAt).toEqual(expect.any(String));
    expect(saved["legacy-tool"]).toBeUndefined();
  });

  test("rejects duplicate tags across live and persisted instances", () => {
    const live = makeChannelInstance("live-channel", "Live Channel");
    getInstances().set("live-channel", live);
    expect(setInstanceTag("live-channel", "ops")).toBe(true);

    saveChannelState("_hub", "instance-identities", {
      "live-channel": { tag: "ops", description: "Live Channel", isChannel: true, lastSeenAt: new Date().toISOString() },
      "offline-channel": { tag: "qa", description: "Offline Channel", isChannel: true, lastSeenAt: new Date().toISOString() },
    });

    expect(setInstanceTag("live-channel", "qa")).toBe(false);
    expect(live.tag).toBe("ops");
  });
});
