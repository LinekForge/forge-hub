#!/usr/bin/env bun
/**
 * Forge Engine — 定时行动引擎
 *
 * 独立的 channel MCP server。定时触发心跳、提醒、指令，
 * 通过 MCP notification 注入 Claude 上下文。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  CHANNEL_NAME,
  CHANNEL_VERSION,
  SCHEDULE_DIR,
  ACTION_LOG_FILE,
  log,
  logError,
} from "./config.js";
import { startScheduler } from "./scheduler.js";
import type { RawScheduleEntry } from "./types.js";
import { resolveTaskTiming } from "./task-timing.js";
import type { EngineAddTaskArgs } from "./task-timing.js";

// ── Orphan Cleanup ─────────────────────────────────────────────────────────

/**
 * 清理孤儿进程。找到所有没有 terminal 的同名进程（即孤儿），杀掉。
 * 有 terminal 的说明有活跃的 Claude 会话在用，不动。
 * 解决 Claude Code 不清理 MCP server 子进程的已知 bug（#1935）。
 */
function cleanOrphans(): void {
  try {
    const { execFileSync } = require("node:child_process");
    const output = execFileSync("ps", ["-eo", "pid,tty,command"], { encoding: "utf-8" });

    let cleaned = 0;
    for (const line of output.split("\n")) {
      if (!line.includes("engine-channel") || line.includes("grep")) continue;

      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[0], 10);
      const tty = parts[1];

      if (pid === process.pid) continue;
      if (tty !== "??" && tty !== "?") continue;

      try {
        process.kill(pid, "SIGTERM");
        cleaned++;
      } catch {}
    }

    if (cleaned > 0) log(`🧹 清理 ${cleaned} 个孤儿进程`);
  } catch {}
}

// ── Constants ──────────────────────────────────────────────────────────────

const DAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
const MONTH_NAMES = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(hour: number, minute: number, second: number): string {
  const sec = second > 0 ? `:${pad2(second)}` : "";
  return `${pad2(hour)}:${pad2(minute)}${sec}`;
}

// ── MCP Channel Server ─────────────────────────────────────────────────────

const server = new Server(
  { name: CHANNEL_NAME, version: CHANNEL_VERSION },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
    instructions: [
      "你是定时行动引擎。这个通道的消息是定时触发的——心跳、提醒、指令。",
      "",
      "收到 [heartbeat] → 根据内容给用户发消息，用通知里提供的通道信息。正在聊天就不用发。",
      "收到 [提醒] → 用你自己的方式通过配置的通道提醒用户。",
      "收到 [指令] → 按指令内容执行。",
      "",
      "通道信息会随每条通知附带，不需要记忆。",
      "",
      "你可以用 engine_add_task 工具动态添加定时任务（比如用户说'一小时后提醒我做什么'）。",
      "查看和管理任务用 Bash 调 forge CLI（如 `fh engine list`、`fh engine remove <label>`）。",
    ].join("\n"),
  },
);

// ── Tool Definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "engine_add_task",
      description:
        "动态添加一个定时任务。写入 engine.d/ 配置目录，热加载自动生效。支持 one_shot（触发后自动删除）。",
      inputSchema: {
        type: "object" as const,
        properties: {
          hour: {
            type: "number",
            description: "触发小时（0-23）",
          },
          minute: {
            type: "number",
            description: "触发分钟（0-59）",
          },
          second: {
            type: "number",
            description: "触发秒（0-59）",
          },
          delay_seconds: {
            type: "number",
            description:
              "相对时间：N 秒后触发。传了这个就不需要 hour/minute/second，engine 自动算。",
          },
          template: {
            type: "string",
            description:
              '通知内容模板。可用变量：{time} {date} {weekday} {label} {prompt} {contacts}。例："[提醒] {time}。{prompt}"',
          },
          prompt: {
            type: "string",
            description: "模板中 {prompt} 变量的值",
          },
          label: {
            type: "string",
            description: "模板中 {label} 变量的值（可选）",
          },
          sender: {
            type: "string",
            description: '通知的 sender 标识（默认 "reminder"）',
          },
          one_shot: {
            type: "boolean",
            description: "是否为一次性任务，触发后自动删除该条任务（默认 true）",
          },
          weekdays: {
            type: "array",
            items: { type: "number" },
            description:
              "哪几天触发（0=周日, 1=周一...6=周六）。不传=不限。例：[1,3,5]=周一三五",
          },
          days: {
            type: "array",
            items: { type: "number" },
            description:
              "每月几号触发（1-31）。不传=不限。例：[1,15]=每月1号和15号",
          },
          months: {
            type: "array",
            items: { type: "number" },
            description:
              "每年几月触发（1-12）。不传=不限。例：[10]=每年10月",
          },
          start_date: {
            type: "string",
            description:
              '有效期开始（YYYY-MM-DD）。该日期之前不触发。例："2027-01-01"',
          },
          end_date: {
            type: "string",
            description:
              '有效期结束（YYYY-MM-DD）。该日期之后不触发。例："2027-12-31"',
          },
        },
        required: ["prompt"],
      },
    },
  ],
}));

// ── Tool Handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  // ── engine_add_task ──
  if (req.params.name === "engine_add_task") {
    const args = req.params.arguments as EngineAddTaskArgs;
    const { hour, minute, second, target, start_date, end_date } = resolveTaskTiming(args);

    const id = crypto.randomBytes(4).toString("hex");
    const oneShot = args.one_shot !== false; // default true
    const filename = oneShot ? `oneshot_${id}.json` : `task_${id}.json`;
    const filePath = path.join(SCHEDULE_DIR, filename);

    const schedule: RawScheduleEntry = {
      hour,
      minute,
      second,
      template: args.template ?? "[提醒] {time}。{prompt}",
      prompt: args.prompt,
      label: args.label,
      sender: args.sender ?? "reminder",
      source: "ai" as const,
      ...(oneShot ? { one_shot: true } : {}),
      ...(args.weekdays ? { weekdays: args.weekdays } : {}),
      ...(args.days ? { days: args.days } : {}),
      ...(args.months ? { months: args.months } : {}),
      ...(start_date ? { start_date } : {}),
      ...(end_date ? { end_date } : {}),
    };

    const config = {
      schedules: [schedule],
    };

    try {
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
      const displayTime = target
        ? `${formatDate(target)} ${formatTime(hour, minute, second)}`
        : formatTime(hour, minute, second);
      log(`📝 添加任务: ${filename} @ ${displayTime}`);

      // Build descriptive response
      const parts: string[] = [`任务已添加: ${filename} @ ${displayTime}`];

      // Schedule description
      const scheduleParts: string[] = [];

      if (args.months?.length) scheduleParts.push(`每年${args.months.map((m) => MONTH_NAMES[m-1]).join("、")}`);
      if (args.days?.length) scheduleParts.push(`每月${args.days.join("、")}号`);
      if (args.weekdays?.length) scheduleParts.push(`每${args.weekdays.map((d) => `周${DAY_NAMES[d]}`).join("、")}`);
      if (args.start_date) scheduleParts.push(`从 ${args.start_date} 起`);
      if (args.end_date) scheduleParts.push(`到 ${args.end_date} 止`);
      if (scheduleParts.length > 0) parts.push(scheduleParts.join("，"));

      if (oneShot) parts.push("（一次性，触发后自动删除）");

      // Check if time already passed today (skip for delay_seconds, always in future)
      if (!args.delay_seconds) {
        const now = new Date();
        const todayTarget = new Date(now);
        todayTarget.setHours(hour, minute, second, 0);
        if (todayTarget.getTime() <= now.getTime() && oneShot) {
          parts.push("⚠ 今天该时间已过，将在明天首次触发");
        }
      }

      return {
        content: [
          { type: "text" as const, text: parts.join("\n") },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `添加失败: ${String(err)}` },
        ],
      };
    }
  }

  throw new Error(`unknown tool: ${req.params.name}`);
});

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  cleanOrphans();
  await server.connect(new StdioServerTransport());
  log("MCP 连接就绪");

  await startScheduler(server);

  log("engine started");
}

if (import.meta.main) {
  main().catch((err) => {
    logError(`Fatal: ${String(err)}`);
    process.exit(1);
  });
}
