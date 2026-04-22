import { describe, expect, test } from "bun:test";

import { resolveTaskTiming } from "./task-timing.js";

describe("resolveTaskTiming", () => {
  test("pins delayed one-shot tasks to the computed calendar day", () => {
    const now = new Date(2026, 3, 22, 10, 0, 0);
    const resolved = resolveTaskTiming(
      {
        prompt: "26 小时后提醒我",
        delay_seconds: 26 * 60 * 60,
      },
      now,
    );

    expect(resolved.hour).toBe(12);
    expect(resolved.minute).toBe(0);
    expect(resolved.second).toBe(0);
    expect(resolved.start_date).toBe("2026-04-23");
    expect(resolved.end_date).toBe("2026-04-23");
  });

  test("delayed recurring tasks only auto-fill start_date", () => {
    const now = new Date(2026, 3, 22, 10, 0, 0);
    const resolved = resolveTaskTiming(
      {
        prompt: "三天后开始每天提醒我",
        delay_seconds: 3 * 24 * 60 * 60,
        one_shot: false,
      },
      now,
    );

    expect(resolved.start_date).toBe("2026-04-25");
    expect(resolved.end_date).toBeUndefined();
  });
});
