import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandRandom, removeScheduleEntryFromFile, shouldFire } from "./scheduler.js";

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("scheduler helpers", () => {
  test("expandRandom keeps daily_count as a hard cap", () => {
    const expanded = expandRandom({
      expand: "random",
      hour: 0,
      minute: 0,
      active_start: 8,
      active_end: 22,
      daily_count: 5,
      min_per_hour: 1,
      template: "[heartbeat] ping",
      sender: "heartbeat",
    });

    expect(expanded).toHaveLength(5);
    for (const entry of expanded) {
      expect(entry.hour).toBeGreaterThanOrEqual(8);
      expect(entry.hour).toBeLessThan(22);
    }
  });

  test("removeScheduleEntryFromFile rewrites a multi-entry file in place", () => {
    const dir = mkTempDir("forge-engine-scheduler-");
    const filePath = path.join(dir, "mixed.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          note: "keep me",
          schedules: [
            { hour: 9, minute: 0, label: "once", one_shot: true },
            { hour: 10, minute: 30, label: "daily" },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = removeScheduleEntryFromFile(filePath, 0);
    const next = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      note?: string;
      schedules: Array<{ label?: string }>;
    };

    expect(result).toEqual({ removed: true, remaining: 1 });
    expect(next.note).toBe("keep me");
    expect(next.schedules).toHaveLength(1);
    expect(next.schedules[0]?.label).toBe("daily");
  });

  test("removeScheduleEntryFromFile deletes the file when the last entry is removed", () => {
    const dir = mkTempDir("forge-engine-scheduler-");
    const filePath = path.join(dir, "oneshot.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          schedules: [{ hour: 9, minute: 0, one_shot: true }],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = removeScheduleEntryFromFile(filePath, 0);

    expect(result).toEqual({ removed: true, remaining: 0 });
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe("shouldFire 时间规则", () => {
  // 回归：错过任务检测原本只走 canScheduleToday（仅查 start_date/end_date），
  // 未过 shouldFire，导致「每周日」的任务在周六被报成「今天错过」。
  test("weekdays 不匹配当天时返回 false", () => {
    const today = new Date().getDay();
    const otherDay = (today + 1) % 7;
    expect(shouldFire({ hour: 22, minute: 0, second: 0, sender: "t", weekdays: [otherDay] } as never)).toBe(false);
    expect(shouldFire({ hour: 22, minute: 0, second: 0, sender: "t", weekdays: [today] } as never)).toBe(true);
  });

  test("days 不匹配当天日期时返回 false", () => {
    const d = new Date().getDate();
    const other = d === 1 ? 2 : 1;
    expect(shouldFire({ hour: 9, minute: 0, second: 0, sender: "t", days: [other] } as never)).toBe(false);
    expect(shouldFire({ hour: 9, minute: 0, second: 0, sender: "t", days: [d] } as never)).toBe(true);
  });

  test("无时间条件时默认可触发", () => {
    expect(shouldFire({ hour: 0, minute: 0, second: 0, sender: "t" } as never)).toBe(true);
  });
});
