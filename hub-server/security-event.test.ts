import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SecurityEventAggregator } from "./security-event.js";

let hubDir: string;
let alertMessages: string[];
let alertCount: number;
let aggregator: SecurityEventAggregator;

beforeEach(() => {
  hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-security-test-"));
  process.env.FORGE_HUB_DIR = hubDir;
  alertMessages = [];
  alertCount = 0;
  aggregator = new SecurityEventAggregator((msg) => {
    alertCount++;
    alertMessages.push(msg);
  });
});

afterEach(() => {
  aggregator.flushAndStop();
  fs.rmSync(hubDir, { recursive: true, force: true });
});

describe("SecurityEventAggregator", () => {
  // ── 1. Single unauthorized message ──────────────────────────────────────

  test("single recordUnauthorized creates an event with correct fields", () => {
    aggregator.recordUnauthorized({
      channel: "telegram",
      sourceUserId: "user_123",
      contentType: "text",
      evidenceId: "ev_001",
    });

    const events = aggregator.getActiveEvents();
    expect(events).toHaveLength(1);

    const ev = events[0];
    expect(ev.event_type).toBe("unauthorized_contact");
    expect(ev.channel).toBe("telegram");
    expect(ev.message_count).toBe(1);
    expect(ev.sender_count).toBe(1);
    expect(ev.source_user_ids).toEqual(["user_123"]);
    expect(ev.evidence_ids).toEqual(["ev_001"]);
    expect(ev.llm_called).toBe(false);
    expect(ev.tool_called).toBe(false);
    expect(ev.memory_written).toBe(false);
    expect(ev.blocked_reason).toBe("not_in_allowlist");
    expect(ev.text_count).toBe(1);
    expect(ev.nontext_count).toBe(0);
    expect(ev.event_id).toBeTruthy();
    expect(ev.first_seen_at).toBeTruthy();
    expect(ev.last_seen_at).toBeTruthy();
  });

  // ── 2. Flood aggregation ────────────────────────────────────────────────

  test("100 calls with same sourceUserId produce 1 event with message_count=100", () => {
    for (let i = 0; i < 100; i++) {
      aggregator.recordUnauthorized({
        channel: "telegram",
        sourceUserId: "flood_user",
        contentType: "text",
        evidenceId: `ev_${i}`,
      });
    }

    const events = aggregator.getActiveEvents();
    expect(events).toHaveLength(1);
    expect(events[0].message_count).toBe(100);
    expect(events[0].sender_count).toBe(1);
    expect(events[0].source_user_ids).toEqual(["flood_user"]);
    expect(events[0].evidence_ids).toHaveLength(100);
  });

  // ── 3. Cross-user aggregation ───────────────────────────────────────────

  test("10 different sourceUserIds produce 1 event with sender_count=10", () => {
    for (let i = 0; i < 10; i++) {
      aggregator.recordUnauthorized({
        channel: "telegram",
        sourceUserId: `user_${i}`,
        contentType: "text",
        evidenceId: `ev_${i}`,
      });
    }

    const events = aggregator.getActiveEvents();
    expect(events).toHaveLength(1);
    expect(events[0].sender_count).toBe(10);
    expect(events[0].message_count).toBe(10);
    expect(events[0].source_user_ids).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect(events[0].source_user_ids).toContain(`user_${i}`);
    }
  });

  // ── 4. Main context alert limit ─────────────────────────────────────────

  test("onMainContextAlert is NOT called synchronously during recordUnauthorized", () => {
    for (let i = 0; i < 100; i++) {
      aggregator.recordUnauthorized({
        channel: "telegram",
        sourceUserId: `user_${i % 5}`,
        contentType: "text",
        evidenceId: `ev_${i}`,
      });
    }

    // Alert fires after GROUP_WAIT_MS (5s) via setTimeout — should be 0 synchronously
    expect(alertCount).toBe(0);

    // But the event data is already recorded
    const events = aggregator.getActiveEvents();
    expect(events).toHaveLength(1);
    expect(events[0].message_count).toBe(100);
  });

  // ── 5. Alert contains no external fields ────────────────────────────────

  test("alert text is a fixed template without sourceUserId, displayName, or content", async () => {
    aggregator.recordUnauthorized({
      channel: "telegram",
      sourceUserId: "evil_user_42",
      contentType: "text",
      evidenceId: "ev_secret",
    });

    // Wait for GROUP_WAIT_MS (5s) + buffer
    await new Promise((r) => setTimeout(r, 6000));

    expect(alertCount).toBe(1);
    const msg = alertMessages[0];

    // Should be the fixed template
    expect(msg).toContain("⚠️ 检测到未授权访问尝试");
    expect(msg).toContain("telegram");

    // Must NOT contain any external/user data
    expect(msg).not.toContain("evil_user_42");
    expect(msg).not.toContain("ev_secret");
  }, 10000);

  test("alert flushes security event before notifying main context", async () => {
    let fileExistsDuringAlert = false;
    let eventWasMarkedDuringAlert = false;
    aggregator.flushAndStop();
    aggregator = new SecurityEventAggregator(() => {
      const filePath = path.join(hubDir, "security-events.jsonl");
      fileExistsDuringAlert = fs.existsSync(filePath);
      if (fileExistsDuringAlert) {
        const line = fs.readFileSync(filePath, "utf-8").trim().split("\n").at(-1);
        const parsed = line ? JSON.parse(line) : null;
        eventWasMarkedDuringAlert = parsed?.main_context_alert_emitted === true;
      }
    });

    aggregator.recordUnauthorized({
      channel: "telegram",
      sourceUserId: "evil_user_42",
      contentType: "text",
      evidenceId: "ev_secret",
    });

    await new Promise((r) => setTimeout(r, 6000));

    expect(fileExistsDuringAlert).toBe(true);
    expect(eventWasMarkedDuringAlert).toBe(true);
    expect(aggregator.getActiveEvents()).toHaveLength(0);
  }, 10000);

  // ── 6. Flush writes to disk ─────────────────────────────────────────────

  test("flush writes security-events.jsonl with correct content", () => {
    aggregator.recordUnauthorized({
      channel: "wechat",
      sourceUserId: "wxid_test",
      contentType: "text",
      evidenceId: "ev_wx_1",
    });
    aggregator.recordUnauthorized({
      channel: "wechat",
      sourceUserId: "wxid_test",
      contentType: "image",
      evidenceId: "ev_wx_2",
    });

    aggregator.flush();

    const filePath = path.join(hubDir, "security-events.jsonl");
    expect(fs.existsSync(filePath)).toBe(true);

    const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1); // single aggregated event

    const parsed = JSON.parse(lines[0]);
    expect(parsed.channel).toBe("wechat");
    expect(parsed.message_count).toBe(2);
    expect(parsed.text_count).toBe(1);
    expect(parsed.nontext_count).toBe(1);
    expect(parsed.source_user_ids).toEqual(["wxid_test"]);

    // After flush, events map should be cleared
    expect(aggregator.getActiveEvents()).toHaveLength(0);
  });

  // ── 7. Flush on error preserves events ──────────────────────────────────

  test("flush failure preserves events for retry", () => {
    aggregator.recordUnauthorized({
      channel: "telegram",
      sourceUserId: "user_retry",
      contentType: "text",
      evidenceId: "ev_retry",
    });

    // Point FORGE_HUB_DIR to a path that cannot be written
    // (a file, not a directory — appendFileSync will fail)
    const fakePath = path.join(hubDir, "not-a-dir-file");
    fs.writeFileSync(fakePath, "blocker");
    process.env.FORGE_HUB_DIR = fakePath;

    aggregator.flush();

    // Events should still be in memory since flush failed
    const events = aggregator.getActiveEvents();
    expect(events).toHaveLength(1);
    expect(events[0].message_count).toBe(1);
    expect(events[0].source_user_ids).toEqual(["user_retry"]);

    // Restore so afterEach cleanup works
    process.env.FORGE_HUB_DIR = hubDir;
  });
});
