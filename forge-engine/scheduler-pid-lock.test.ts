import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// config.ts 在模块加载时就求值 DATA_DIR，所以 env 必须先于 import scheduler 设好。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-engine-pid-"));
process.env.FORGE_ENGINE_DATA = tempDir;

const { startScheduler, stopScheduler, retryPassivePromotion, isPassiveMode } =
  await import("./scheduler.js");

const PID_FILE = path.join(tempDir, "engine.pid");

/** fire() 只用到 server.notification，最小替身足够。 */
function fakeServer(): Server {
  return { notification: async () => {} } as unknown as Server;
}

/** 一个必定不存在的 PID，用来伪造崩溃进程留下的陈旧锁。 */
function deadPid(): number {
  for (let pid = 40000; pid < 41000; pid++) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid; // kill 抛错 = 进程不存在
    }
  }
  throw new Error("找不到空闲 PID");
}

afterEach(() => {
  stopScheduler();
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* 已经没了 */
  }
});

describe("PID lock re-election", () => {
  test("second instance enters passive mode while the lock holder is alive", async () => {
    fs.writeFileSync(PID_FILE, String(process.pid)); // 本进程当然活着

    await startScheduler(fakeServer());

    expect(isPassiveMode()).toBe(true);
  });

  test("passive instance promotes itself once the lock holder exits", async () => {
    fs.writeFileSync(PID_FILE, String(process.pid));
    await startScheduler(fakeServer());
    expect(isPassiveMode()).toBe(true);

    fs.unlinkSync(PID_FILE); // 主实例正常退出会 releasePidLock()

    const promoted = await retryPassivePromotion(fakeServer());

    expect(promoted).toBe(true);
    expect(isPassiveMode()).toBe(false);
    expect(fs.readFileSync(PID_FILE, "utf-8").trim()).toBe(String(process.pid));
  });

  test("passive instance reclaims a stale lock left by a crashed holder", async () => {
    fs.writeFileSync(PID_FILE, String(process.pid));
    await startScheduler(fakeServer());
    expect(isPassiveMode()).toBe(true);

    fs.writeFileSync(PID_FILE, String(deadPid())); // 崩溃：文件还在，进程没了

    const promoted = await retryPassivePromotion(fakeServer());

    expect(promoted).toBe(true);
    expect(isPassiveMode()).toBe(false);
  });

  test("passive instance stays passive while the holder is still alive", async () => {
    fs.writeFileSync(PID_FILE, String(process.pid));
    await startScheduler(fakeServer());
    expect(isPassiveMode()).toBe(true);

    const promoted = await retryPassivePromotion(fakeServer()); // 锁没释放

    expect(promoted).toBe(false);
    expect(isPassiveMode()).toBe(true);
    expect(fs.readFileSync(PID_FILE, "utf-8").trim()).toBe(String(process.pid));
  });
});
