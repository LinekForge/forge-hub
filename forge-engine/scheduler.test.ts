import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  expandRandom,
  fireKey,
  hasFiredToday,
  markFired,
  removeScheduleEntryFromFile,
  shouldFire,
} from "./scheduler.js";

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

describe("已触发记录（错过检测的第二道闸）", () => {
  // 回归：错过判定原本只看「墙上时间 − 排期时刻」落在 2h 窗口内 ＋ shouldFire，
  // 从不查该条目今天是否已经触发过。于是任务时刻之后 2 小时内的任何一次重排
  // （启动 / 配置热加载 / 午夜重排在边界上提前几毫秒跑），都会把已跑完的任务
  // 重新报成「错过」。2026-08-22 / 08-23 / 08-28 / 08-29 连续复发。
  const entry = {
    hour: 22, minute: 0, second: 0,
    sender: "engine", label: "洗澡提醒", origin: "shower.json",
  } as never;

  test("fireKey 对同一条目稳定，对不同时刻/来源不同", () => {
    expect(fireKey(entry)).toBe(fireKey(entry));
    expect(fireKey({ ...(entry as object), minute: 30 } as never)).not.toBe(fireKey(entry));
    expect(fireKey({ ...(entry as object), origin: "other.json" } as never)).not.toBe(fireKey(entry));
  });

  test("label 缺省时回退到 sender，不会把两个条目挤成同一个键", () => {
    const a = { hour: 9, minute: 0, second: 0, sender: "briefing", origin: "x.json" } as never;
    const b = { hour: 9, minute: 0, second: 0, sender: "redline", origin: "x.json" } as never;
    expect(fireKey(a)).not.toBe(fireKey(b));
  });

  test("没有记录时 hasFiredToday 为 false", () => {
    expect(hasFiredToday({}, entry, "2026-08-29")).toBe(false);
  });

  test("markFired 之后同日为 true、次日为 false", () => {
    const state = markFired({}, entry, "2026-08-29");
    expect(hasFiredToday(state, entry, "2026-08-29")).toBe(true);
    expect(hasFiredToday(state, entry, "2026-08-30")).toBe(false);
  });

  test("markFired 清掉非当天的键，状态文件不会无限增长", () => {
    let state: Record<string, unknown> = { "stale.json|09:00:00|旧任务": "2026-01-01" };
    state = markFired(state, entry, "2026-08-29");
    expect(Object.keys(state)).toEqual([fireKey(entry)]);
  });

  test("同一天重复 markFired 不产生第二个键", () => {
    let state = markFired({}, entry, "2026-08-29");
    state = markFired(state, entry, "2026-08-29");
    expect(Object.keys(state)).toHaveLength(1);
  });
});
