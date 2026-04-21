/**
 * 分模块状态管理
 *
 * 每个模块一个 JSON 文件：forge-state/<module>.json
 */

import fs from "node:fs";
import path from "node:path";

import { STATE_DIR, logError } from "./config.js";

export function loadState(module: string): Record<string, unknown> {
  const filePath = path.join(STATE_DIR, `${module}.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    logError(`读取状态 ${module} 失败: ${String(err)}`);
  }
  return {};
}

export function saveState(
  module: string,
  state: Record<string, unknown>,
): void {
  const filePath = path.join(STATE_DIR, `${module}.json`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    logError(`写入状态 ${module} 失败: ${String(err)}`);
  }
}
