/**
 * 可插拔 Handler 加载器
 *
 * 启动时扫描 handlers/ 目录，动态 import 所有 .ts 文件。
 * 每个 handler 文件 export default 一个 ScheduleHandler 对象。
 */

import fs from "node:fs";
import path from "node:path";

import { HANDLERS_DIR, log, logError } from "./config.js";
import type { ScheduleHandler } from "./types.js";

export async function scanHandlers(): Promise<Map<string, ScheduleHandler>> {
  const handlers = new Map<string, ScheduleHandler>();

  try {
    if (!fs.existsSync(HANDLERS_DIR)) return handlers;

    const files = fs
      .readdirSync(HANDLERS_DIR)
      .filter((f) => f.endsWith(".ts") && f !== ".gitkeep");

    for (const file of files) {
      try {
        const filePath = path.join(HANDLERS_DIR, file);
        const mod = await import(filePath);
        const handler: ScheduleHandler = mod.default;

        if (!handler?.name || !handler?.buildContent) {
          logError(`${file}: 缺少 name 或 buildContent，跳过`);
          continue;
        }

        handlers.set(handler.name, handler);
        log(`🔌 加载 handler: ${handler.name} (${file})`);
      } catch (err) {
        logError(`加载 handler ${file} 失败: ${String(err)}`);
      }
    }
  } catch (err) {
    logError(`扫描 handlers/ 失败: ${String(err)}`);
  }

  if (handlers.size > 0) {
    log(`🔌 共加载 ${handlers.size} 个 handler`);
  }

  return handlers;
}
