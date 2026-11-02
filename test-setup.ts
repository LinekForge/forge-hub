/**
 * Test environment isolation — runs before every test file.
 *
 * Redirects FORGE_HUB_DIR to a temporary directory so that tests
 * never read or write the real ~/.forge-hub/ state (allowlists,
 * credentials, chat history, etc.).
 *
 * Without this, bun's cross-file module cache can cause STATE_DIR
 * to resolve to the real home directory, and test assertions that
 * call saveChannelState() will silently overwrite production data.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.FORGE_HUB_DIR) {
  process.env.FORGE_HUB_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "forge-hub-test-"),
  );
}

// forge-engine 的 config.ts 也在模块加载时求值 DATA_DIR；不隔离的话，
// 跨文件模块缓存会让 scheduler-pid-lock 测试写到真实 ~/.forge-hub/engine-data。
if (!process.env.FORGE_ENGINE_DATA) {
  process.env.FORGE_ENGINE_DATA = fs.mkdtempSync(
    path.join(os.tmpdir(), "forge-engine-test-"),
  );
}
