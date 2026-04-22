import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildEngineLogEntry,
  findEngineRemoveMatches,
  formatLocalTimestamp,
  getEnginePaths,
  listEngineSchedules,
  updateEnginePauseConfig,
} from "./engine.js";

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

describe("engine CLI helpers", () => {
  test("lists schedules with readable tags", () => {
    const home = mkTempDir("forge-engine-cli-");
    const { engineScheduleDir } = getEnginePaths(home);
    fs.mkdirSync(engineScheduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(engineScheduleDir, "heartbeat.json"),
      JSON.stringify({
        schedules: [
          {
            hour: 9,
            minute: 30,
            one_shot: true,
            weekdays: [1, 3, 5],
            source: "ai",
            prompt: "提醒我喝水",
          },
        ],
      }),
      "utf-8",
    );

    const lines = listEngineSchedules(engineScheduleDir);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.line).toContain("heartbeat.json @ 09:30");
    expect(lines[0]?.line).toContain("一次性");
    expect(lines[0]?.line).toContain("周一");
    expect(lines[0]?.line).toContain("动态");
    expect(lines[0]?.line).toContain("提醒我喝水");
  });

  test("finds remove matches by prompt or label", () => {
    const home = mkTempDir("forge-engine-cli-");
    const { engineScheduleDir } = getEnginePaths(home);
    fs.mkdirSync(engineScheduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(engineScheduleDir, "focus.json"),
      JSON.stringify({
        schedules: [
          { hour: 8, minute: 0, label: "晨间提醒" },
          { hour: 20, minute: 0, prompt: "收尾检查" },
        ],
      }),
      "utf-8",
    );

    expect(findEngineRemoveMatches(engineScheduleDir, "晨间")).toEqual([
      { file: "focus.json", prompt: "晨间提醒", time: "08:00" },
    ]);
    expect(findEngineRemoveMatches(engineScheduleDir, "收尾")).toEqual([
      { file: "focus.json", prompt: "收尾检查", time: "20:00" },
    ]);
  });

  test("pause 0 resumes engine immediately", () => {
    const resumed = updateEnginePauseConfig(
      { enabled: false, pause_until: "2026-04-22T20:30:00.000Z" },
      0,
    );
    expect(resumed.enabled).toBe(true);
    expect("pause_until" in resumed).toBe(false);
  });

  test("builds manual engine log entry", () => {
    const entry = buildEngineLogEntry("补记一条行动", new Date("2026-04-22T12:34:00.000Z"));
    expect(entry).toContain("## 2026-04-22 12:34");
    expect(entry).toContain("- 补记一条行动");
  });

  test("formats pause timestamp for local display", () => {
    expect(formatLocalTimestamp("2026-04-22T12:34:00.000Z")).toBe("2026-04-22 12:34");
  });
});
