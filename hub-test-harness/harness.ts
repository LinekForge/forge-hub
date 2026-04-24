#!/usr/bin/env bun
/**
 * Forge Hub Test Harness · 独立测试 binary
 *
 * 动机：Hub 的 self-test 需要"注入用户的消息"和"触发 crash"——这些如果做成
 * 生产 Hub 里的 /test/* endpoints，就等于在生产 binary 上留攻击面（即使 env
 * gate 关着，endpoint 代码路径还在，软门不如不存在）。
 *
 * 这个 harness 的做法：
 *   1. mkdtemp 一个临时 HUB_DIR
 *   2. 在临时 dir 的 channels/ 放 test-injector.ts（伪装 wechat）
 *   3. spawn 一个独立的 Hub 进程，指向临时 dir + 临时端口
 *   4. 通过 test-injector 的控制端口跑 scenarios
 *   5. 跑完清理
 *
 * 用户日常使用的生产 Hub **完全不受影响**——不同进程、不同端口、不同数据目录。
 * 生产 Hub 代码里 grep "/test" 返回 0 结果。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// ── 路径常量 ────────────────────────────────────────────────────────────────

const HARNESS_DIR = import.meta.dir;
const HUB_SERVER_PATH = path.resolve(HARNESS_DIR, "../hub-server/hub.ts");
const INJECTOR_SRC = path.join(HARNESS_DIR, "test-injector.ts");

const TEST_HUB_PORT = Number(process.env.FORGE_HUB_TEST_PORT ?? 9901);
const HUB_URL = `http://127.0.0.1:${TEST_HUB_PORT}`;
// injector 走 unix socket（只有同用户 + 同 tmpdir 权限能 connect）
// 路径由 startTestHub 返回，下面 scenarios 全用 injectorFetch helper
let INJECTOR_SOCKET = "";

const TEST_OWNER_ID = "test-owner-wechat-id";
const TEST_OWNER_NAME = "测试主人";
const TEST_INSTANCE = "test-self-e2e-instance";

// ── 启动 test Hub ───────────────────────────────────────────────────────────

interface TestHub {
  tmpDir: string;
  child: ChildProcess;
}

async function startTestHub(): Promise<TestHub> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-test-"));
  INJECTOR_SOCKET = path.join(tmpDir, "injector.sock");

  // Channels dir + inject injector as fake wechat
  const channelsDir = path.join(tmpDir, "channels");
  fs.mkdirSync(channelsDir, { recursive: true });
  fs.copyFileSync(INJECTOR_SRC, path.join(channelsDir, "wechat.ts"));

  // Allowlist for wechat（test-injector 伪装的通道名）
  const allowlistDir = path.join(tmpDir, "state", "wechat");
  fs.mkdirSync(allowlistDir, { recursive: true });
  fs.writeFileSync(
    path.join(allowlistDir, "allowlist.json"),
    JSON.stringify({
      allowed: [{ id: TEST_OWNER_ID, nickname: TEST_OWNER_NAME }],
      auto_allow_next: false,
      approval_owner_id: TEST_OWNER_ID,
    }, null, 2),
  );

  // hub-config.json
  fs.writeFileSync(
    path.join(tmpDir, "hub-config.json"),
    JSON.stringify({
      port: TEST_HUB_PORT,
      host: "127.0.0.1",
      primary_instance: "",
      show_instance_tag: false,
      approval_channels: ["wechat"],
      auto_replay_on_ready: false,
    }, null, 2),
  );

  // spawn Hub with env overrides
  const child = spawn("bun", [HUB_SERVER_PATH], {
    env: {
      ...process.env,
      FORGE_HUB_DIR: tmpDir,
      FORGE_HUB_CHANNELS_DIR: channelsDir,
      FORGE_HUB_TEST_INJECTOR_SOCKET: INJECTOR_SOCKET,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", () => {});  // silence
  child.stderr?.on("data", () => {});

  // Wait for Hub + injector both up
  const deadline = Date.now() + 15_000;
  let hubUp = false;
  let injectorUp = false;
  while (Date.now() < deadline) {
    if (!hubUp) {
      try {
        const r = await fetch(`${HUB_URL}/status`);
        if (r.ok) hubUp = true;
      } catch {}
    }
    if (!injectorUp) {
      // injector socket 文件存在即视为 ready（Bun.serve 创建 socket 后就开 accept）
      if (fs.existsSync(INJECTOR_SOCKET)) injectorUp = true;
    }
    if (hubUp && injectorUp) break;
    await sleep(100);
  }
  if (!hubUp) throw new Error(`test Hub 未在 15s 内启动 (port ${TEST_HUB_PORT})`);
  if (!injectorUp) throw new Error(`test injector 未在 15s 内启动 (socket ${INJECTOR_SOCKET})`);

  return { tmpDir, child };
}

// 走 Unix socket 发 HTTP 请求——Bun fetch 原生支持 `unix` option
async function injectorFetch(pathname: string, body: unknown): Promise<Response> {
  return await fetch(`http://localhost${pathname}`, {
    unix: INJECTOR_SOCKET,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  } as any);
}

async function stopTestHub(hub: TestHub): Promise<void> {
  if (!hub.child.killed) {
    hub.child.kill("SIGTERM");
    // 给它 2s graceful shutdown
    await sleep(500);
    if (!hub.child.killed) {
      try { hub.child.kill("SIGKILL"); } catch {}
    }
  }
  try {
    fs.rmSync(hub.tmpDir, { recursive: true, force: true });
  } catch {}
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function genDisplayId(): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz";
  return Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

async function inject(content: string, fromId = TEST_OWNER_ID, from = TEST_OWNER_NAME): Promise<void> {
  const r = await injectorFetch("/inject", { from, fromId, content });
  if (!r.ok) throw new Error(`inject HTTP ${r.status}`);
}

async function triggerCrash(mode: "sync" | "async"): Promise<void> {
  const r = await injectorFetch("/crash", { mode });
  if (!r.ok) throw new Error(`crash HTTP ${r.status}`);
}

async function findPending(reqId: string): Promise<{ yes_id: string; no_id: string } | null> {
  const r = await fetch(`${HUB_URL}/pending`);
  const data = (await r.json()) as { pending: { request_id: string; yes_id: string; no_id: string }[] };
  const p = data.pending.find((e) => e.request_id === reqId);
  return p ? { yes_id: p.yes_id, no_id: p.no_id } : null;
}

async function registerApproval(label: string): Promise<{ reqId: string; yes_id: string; no_id: string }> {
  const reqId = genDisplayId();
  const r = await fetch(`${HUB_URL}/permission-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: reqId,
      tool_name: `TestTool_${label}`,
      description: `self-test ${label}`,
      input_preview: "",
      instance: TEST_INSTANCE,
    }),
  });
  const data = (await r.json()) as { success: boolean; error?: string };
  if (!data.success) throw new Error(`登记失败: ${data.error}`);
  const p = await findPending(reqId);
  if (!p) throw new Error(`登记后 /pending 查不到 ${reqId}`);
  return { reqId, ...p };
}

async function readAudit(hub: TestHub): Promise<{ ts: string; action: string; request_id?: string; [k: string]: unknown }[]> {
  const auditFile = path.join(hub.tmpDir, "audit.jsonl");
  if (!fs.existsSync(auditFile)) return [];
  const lines = fs.readFileSync(auditFile, "utf-8").trim().split("\n").filter(Boolean);
  return lines.map((l) => JSON.parse(l));
}

async function latestAuditAction(hub: TestHub, reqId: string): Promise<string | null> {
  const entries = await readAudit(hub);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].request_id === reqId) return entries[i].action;
  }
  return null;
}

async function hubPid(): Promise<number | null> {
  try {
    const r = await fetch(`${HUB_URL}/health`);
    const d = (await r.json()) as { hub: { pid: number } };
    return d.hub.pid;
  } catch {
    return null;
  }
}

// ── Scenarios ───────────────────────────────────────────────────────────────

interface Result { name: string; pass: boolean; detail?: string }

async function run(name: string, fn: () => Promise<string | null>): Promise<Result> {
  try {
    const fail = await fn();
    if (fail) return { name, pass: false, detail: fail };
    return { name, pass: true };
  } catch (err) {
    return { name, pass: false, detail: String(err) };
  }
}

async function runScenarios(hub: TestHub): Promise<Result[]> {
  const results: Result[] = [];

  results.push(await run("1. happy allow (yes + yes_id)", async () => {
    const { reqId, yes_id } = await registerApproval("allow");
    await inject(`yes ${yes_id}`);
    await sleep(50);
    if (await findPending(reqId)) return "pending 未清空";
    const action = await latestAuditAction(hub, reqId);
    if (action !== "approval_granted") return `audit action=${action}，期望 approval_granted`;
    return null;
  }));

  results.push(await run("2. happy deny (no + no_id)", async () => {
    const { reqId, no_id } = await registerApproval("deny");
    await inject(`no ${no_id}`);
    await sleep(50);
    if (await findPending(reqId)) return "pending 未清空";
    const action = await latestAuditAction(hub, reqId);
    if (action !== "approval_denied") return `audit action=${action}，期望 approval_denied`;
    return null;
  }));

  results.push(await run("3. mismatch (yes + no_id)", async () => {
    const { reqId, no_id } = await registerApproval("mismatch");
    await inject(`yes ${no_id}`);
    await sleep(50);
    if (!(await findPending(reqId))) return "pending 被错误清空";
    const action = await latestAuditAction(hub, reqId);
    if (action !== "approval_mismatch") return `audit action=${action}，期望 approval_mismatch`;
    const p = await findPending(reqId);
    if (p) await inject(`no ${p.no_id}`);  // cleanup
    return null;
  }));

  results.push(await run("4. malformed (yes + 6 字母)", async () => {
    const { reqId, yes_id } = await registerApproval("malformed");
    await inject("yes abcdef");  // 6 字母
    await sleep(50);
    if (!(await findPending(reqId))) return "pending 被错误清空";
    await inject(`yes ${yes_id}`);  // cleanup
    return null;
  }));

  results.push(await run("5. 非主人触发第二道防线", async () => {
    const { reqId, yes_id } = await registerApproval("stranger");
    await inject(`yes ${yes_id}`, "not-an-owner-999");
    await sleep(50);
    if (!(await findPending(reqId))) return "攻击者消息通过了审批！pending 被清空";
    await inject(`yes ${yes_id}`);  // cleanup
    return null;
  }));

  results.push(await run("6. 无关聊天（没 pending 时 yes/no 不干预）", async () => {
    const p0 = await fetch(`${HUB_URL}/pending`);
    const d0 = (await p0.json()) as { count: number };
    if (d0.count !== 0) return null;  // 有残留 pending 跳过
    await inject("yes randz");  // 无 pending 时应该被当聊天——不抛错即可
    return null;
  }));

  results.push(await run("7. channel crash: sync uncaughtException 不崩 Hub", async () => {
    const pidBefore = await hubPid();
    if (!pidBefore) return "Hub 启动前 pid 未获到";
    await triggerCrash("sync");
    await sleep(200);
    const pidAfter = await hubPid();
    if (pidAfter !== pidBefore) return `Hub 重启了！pid ${pidBefore} → ${pidAfter}`;
    return null;
  }));

  results.push(await run("8. channel crash: unhandledRejection 不崩 Hub", async () => {
    const pidBefore = await hubPid();
    if (!pidBefore) return "Hub 启动前 pid 未获到";
    await triggerCrash("async");
    await sleep(200);
    const pidAfter = await hubPid();
    if (pidAfter !== pidBefore) return `Hub 重启了！pid ${pidBefore} → ${pidAfter}`;
    return null;
  }));

  return results;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n🧪 Forge Hub test harness（独立 Hub 实例 :${TEST_HUB_PORT}）\n`);

  const hub = await startTestHub();
  try {
    const results = await runScenarios(hub);
    for (const r of results) {
      if (r.pass) console.log(`  ✅ ${r.name}`);
      else console.log(`  ❌ ${r.name}: ${r.detail}`);
    }
    const passed = results.filter((r) => r.pass).length;
    const failed = results.length - passed;
    console.log(`\n📊 ${passed}/${results.length} 通过${failed > 0 ? ` (${failed} 失败)` : ""}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    await stopTestHub(hub);
  }
}

main().catch((err) => {
  console.error("harness 顶层异常:", err);
  process.exitCode = 1;
});
