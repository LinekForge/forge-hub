import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expandRandom, removeScheduleEntryFromFile } from "./scheduler.js";

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
