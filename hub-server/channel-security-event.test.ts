import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createHubAPI } from "./channel-loader.js";

describe("channel security event bridge", () => {
  test("HubAPI injects channel name into channel-level security events", () => {
    const events: unknown[] = [];
    const hub = createHubAPI("telegram", () => {}, (params) => events.push(params));

    hub.recordSecurityEvent({
      sourceUserId: "attacker-1",
      contentType: "text",
      evidenceId: "ev-001",
    });

    expect(events).toEqual([
      {
        channel: "telegram",
        sourceUserId: "attacker-1",
        contentType: "text",
        evidenceId: "ev-001",
      },
    ]);
  });

  test("every channel unauthorized evidence branch records a security event", () => {
    const channelFiles = ["telegram.ts", "feishu.ts", "wechat.ts", "imessage.ts"];

    for (const file of channelFiles) {
      const source = fs.readFileSync(path.join(import.meta.dir, "channels", file), "utf-8");
      const evidenceCalls = source.match(/recordUnauthorizedEvidence\(/g)?.length ?? 0;
      const eventCalls = source.match(/\b(?:hub|hubApi)\.recordSecurityEvent\(/g)?.length ?? 0;

      expect(evidenceCalls).toBeGreaterThan(0);
      expect(eventCalls).toBe(evidenceCalls);
    }
  });
});
