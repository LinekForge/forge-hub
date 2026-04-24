import { describe, expect, test } from "bun:test";

import {
  formatKnownState,
  getInstancePresence,
  partitionInstances,
} from "./hub-instance-view.js";

describe("hub instance view helpers", () => {
  test("prefers explicit presence and falls back to connectedAt", () => {
    expect(getInstancePresence({ id: "live-1", presence: "live" })).toBe("live");
    expect(getInstancePresence({ id: "known-1", presence: "known", connectedAt: new Date().toISOString() })).toBe("known");
    expect(getInstancePresence({ id: "live-2", connectedAt: new Date().toISOString() })).toBe("live");
    expect(getInstancePresence({ id: "known-2" })).toBe("known");
  });

  test("partitions live and known instances", () => {
    const { live, known } = partitionInstances([
      { id: "live-1", presence: "live" },
      { id: "known-1", presence: "known" },
      { id: "live-2", connectedAt: new Date().toISOString() },
    ]);

    expect(live.map((instance) => instance.id)).toEqual(["live-1", "live-2"]);
    expect(known.map((instance) => instance.id)).toEqual(["known-1"]);
  });

  test("formats offline/tool-only state with relative last seen time", () => {
    const now = Date.parse("2026-04-23T12:00:00.000Z");
    expect(
      formatKnownState(
        {
          id: "tool-1",
          isChannel: false,
          lastSeenAt: "2026-04-23T11:55:00.000Z",
        },
        now,
      ),
    ).toBe("仅工具 · 上次出现 5m前");

    expect(
      formatKnownState(
        {
          id: "channel-1",
          isChannel: true,
          lastSeenAt: "2026-04-23T10:00:00.000Z",
        },
        now,
      ),
    ).toBe("离线 · 上次出现 2h前");
  });
});
