import fs from "node:fs";
import path from "node:path";

const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

export interface EnginePaths {
  engineDir: string;
  engineScheduleDir: string;
  engineLogFile: string;
  engineConfigFile: string;
}

export interface EngineScheduleSummary {
  file: string;
  line: string;
}

export interface EngineMatch {
  file: string;
  prompt: string;
  time: string;
}

export function getEnginePaths(home = process.env.HOME ?? "~"): EnginePaths {
  const engineDir = path.join(home, ".claude", "channels", "engine");
  return {
    engineDir,
    engineScheduleDir: path.join(engineDir, "engine.d"),
    engineLogFile: path.join(engineDir, "engine-trigger-log.md"),
    engineConfigFile: path.join(engineDir, "engine-config.json"),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

export function listEngineSchedules(
  scheduleDir: string,
): EngineScheduleSummary[] {
  if (!fs.existsSync(scheduleDir)) return [];

  const files = fs.readdirSync(scheduleDir).filter((f) => f.endsWith(".json")).sort();
  const lines: EngineScheduleSummary[] = [];

  for (const file of files) {
    try {
      const data = readJsonFile(path.join(scheduleDir, file)) as { schedules?: Record<string, unknown>[] };
      for (const raw of data.schedules ?? []) {
        const s = raw as {
          expand?: string;
          active_start?: number;
          active_end?: number;
          daily_count?: number;
          hour?: number;
          minute?: number;
          second?: number;
          one_shot?: boolean;
          weekdays?: number[];
          days?: number[];
          months?: number[];
          start_date?: string;
          end_date?: string;
          source?: string;
          prompt?: string;
        };
        if (s.expand === "random") {
          lines.push({
            file,
            line: `${file} — 随机心跳（${s.active_start}:00-${s.active_end}:00，每天${s.daily_count}条）`,
          });
          continue;
        }

        const time = `${pad2(s.hour ?? 0)}:${pad2(s.minute ?? 0)}${s.second ? `:${pad2(s.second)}` : ""}`;
        const tags: string[] = [];
        if (s.one_shot) tags.push("一次性");
        if (s.weekdays?.length) tags.push(`每${s.weekdays.map((d) => `周${DAY_NAMES[d]}`).join("、")}`);
        if (s.days?.length) tags.push(`每月${s.days.join("、")}号`);
        if (s.months?.length) tags.push(`每年${s.months.map((m) => `${m}月`).join("、")}`);
        if (s.start_date) tags.push(`从${s.start_date}`);
        if (s.end_date) tags.push(`到${s.end_date}`);
        if (s.source === "ai") tags.push("动态");
        const tagStr = tags.length > 0 ? ` [${tags.join(", ")}]` : "";
        const prompt = s.prompt ? ` — ${s.prompt.slice(0, 60)}` : "";
        lines.push({
          file,
          line: `${file} @ ${time}${tagStr}${prompt}`,
        });
      }
    } catch {
      lines.push({ file, line: `${file} — 读取失败` });
    }
  }

  return lines;
}

export function findEngineRemoveMatches(
  scheduleDir: string,
  query: string,
): EngineMatch[] {
  if (!fs.existsSync(scheduleDir)) return [];

  const q = query.toLowerCase();
  const files = fs.readdirSync(scheduleDir).filter((f) => f.endsWith(".json")).sort();
  const matches: EngineMatch[] = [];

  for (const file of files) {
    try {
      const data = readJsonFile(path.join(scheduleDir, file)) as { schedules?: Record<string, unknown>[] };
      for (const raw of data.schedules ?? []) {
        const s = raw as { prompt?: string; label?: string; hour?: number; minute?: number };
        const prompt = (s.prompt ?? "").toLowerCase();
        const label = (s.label ?? "").toLowerCase();
        if (prompt.includes(q) || label.includes(q)) {
          matches.push({
            file,
            prompt: s.prompt ?? s.label ?? "",
            time: `${pad2(s.hour ?? 0)}:${pad2(s.minute ?? 0)}`,
          });
        }
      }
    } catch {
      // ignore unreadable files for fuzzy matching
    }
  }

  return matches;
}

export function updateEnginePauseConfig(
  current: Record<string, unknown>,
  minutes: number,
): Record<string, unknown> {
  const next = { ...current };
  if (minutes <= 0) {
    next.enabled = true;
    delete next.pause_until;
    return next;
  }
  next.enabled = false;
  next.pause_until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  return next;
}

export function buildEngineLogEntry(
  text: string,
  now = new Date(),
): string {
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  return `\n## ${dateStr} ${timeStr} — [手动]\n- ${text}\n`;
}

export function formatLocalTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
