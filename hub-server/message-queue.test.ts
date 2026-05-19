import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { HUB_DIR } from "./config.js";
import { initQueue, enqueue, drain as _drain, dequeue, queueSize, closeQueue } from "./message-queue.js";

function drain(channels: string[], limit?: number) {
  const result = _drain(channels, limit);
  if (result === null) throw new Error("drain returned null — unexpected in test");
  return result;
}

const DB_PATH = path.join(HUB_DIR, "queue.db");

// Between tests: close the DB + delete the file so initQueue creates a fresh one
afterEach(() => {
  closeQueue();
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(DB_PATH + suffix); } catch {}
  }
});

describe("message-queue", () => {
  test("initQueue creates the database file", () => {
    initQueue();
    expect(fs.existsSync(DB_PATH)).toBe(true);
  });

  test("enqueue + drain returns messages in order", () => {
    initQueue();

    enqueue("wechat", { text: "first" });
    enqueue("wechat", { text: "second" });
    enqueue("wechat", { text: "third" });

    const msgs = drain(["wechat"]);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].payload).toEqual({ text: "first" });
    expect(msgs[1].payload).toEqual({ text: "second" });
    expect(msgs[2].payload).toEqual({ text: "third" });
    expect(msgs[0].channel).toBe("wechat");
  });

  test("drain filters by channel", () => {
    initQueue();

    enqueue("wechat", { text: "wx1" });
    enqueue("telegram", { text: "tg1" });
    enqueue("wechat", { text: "wx2" });

    const wxMsgs = drain(["wechat"]);
    expect(wxMsgs).toHaveLength(2);
    expect(wxMsgs.map(m => m.payload)).toEqual([
      { text: "wx1" },
      { text: "wx2" },
    ]);

    const tgMsgs = drain(["telegram"]);
    expect(tgMsgs).toHaveLength(1);
    expect(tgMsgs[0].payload).toEqual({ text: "tg1" });
  });

  test("drain with multiple channels returns all matching", () => {
    initQueue();

    enqueue("wechat", { text: "wx" });
    enqueue("telegram", { text: "tg" });
    enqueue("feishu", { text: "fs" });

    const msgs = drain(["wechat", "telegram"]);
    expect(msgs).toHaveLength(2);
  });

  test("drain respects limit", () => {
    initQueue();

    for (let i = 0; i < 10; i++) {
      enqueue("wechat", { i });
    }

    const msgs = drain(["wechat"], 3);
    expect(msgs).toHaveLength(3);
    expect(msgs[0].payload).toEqual({ i: 0 });
    expect(msgs[2].payload).toEqual({ i: 2 });
  });

  test("dequeue removes specific messages", () => {
    initQueue();

    enqueue("wechat", { text: "a" });
    enqueue("wechat", { text: "b" });
    enqueue("wechat", { text: "c" });

    const all = drain(["wechat"]);
    expect(all).toHaveLength(3);

    // Remove the first and third
    dequeue([all[0].id, all[2].id]);

    const remaining = drain(["wechat"]);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].payload).toEqual({ text: "b" });
  });

  test("drain with empty channels returns empty array", () => {
    initQueue();

    enqueue("wechat", { text: "x" });
    expect(drain([])).toEqual([]);
  });

  test("enqueue is no-op when db is not initialized", () => {
    // Don't call initQueue — db is null after afterEach closeQueue
    expect(() => enqueue("wechat", { text: "x" })).not.toThrow();
    expect(drain(["wechat"])).toEqual([]);
  });

  test("queueSize returns correct count", () => {
    initQueue();

    expect(queueSize()).toBe(0);

    enqueue("wechat", { text: "a" });
    enqueue("telegram", { text: "b" });
    expect(queueSize()).toBe(2);

    const msgs = drain(["wechat"]);
    dequeue(msgs.map(m => m.id));
    expect(queueSize()).toBe(1);
  });

  test("closeQueue makes subsequent operations safe no-ops", () => {
    initQueue();

    enqueue("wechat", { text: "before close" });
    closeQueue();

    // After close, all operations should be safe no-ops
    expect(() => enqueue("wechat", { text: "after close" })).not.toThrow();
    expect(drain(["wechat"])).toEqual([]);
    expect(queueSize()).toBe(0);
  });
});
