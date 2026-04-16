/**
 * Test Injector · 伪装成 wechat 的 channel plugin（仅 test harness 使用）
 *
 * 通讯：**Unix socket**（不是 HTTP port）。
 * Socket 路径：`${HUB_DIR}/injector.sock` 或 `FORGE_HUB_TEST_INJECTOR_SOCKET` env 指定。
 * 为什么 Unix socket：tmp HUB_DIR 是 `mkdtemp` 700 权限目录，其他本地进程根本 connect
 * 不到——杜绝"self-test 跑的几秒内 :8899 被污染"的微观攻击面。
 *
 * 控制协议（HTTP over unix socket）：
 *   POST /inject  { from, fromId, content }    → hub.pushMessage（模拟"用户发了微信"）
 *   POST /crash   { mode: "sync" | "async" }   → 触发 process-level 异常（测试 crash isolation）
 *
 * send() 是 no-op（harness 不关心出站实际发送，只关心 Hub 内部状态变化）。
 * 为什么伪装成 wechat：`isApprovalOwner` 读 `state/wechat/allowlist.json`——
 * harness 往这个路径写 allowlist，injector 伪装后所有审批路径自然通。
 */

import fs from "node:fs";
import path from "node:path";
import type { ChannelPlugin, HubAPI, SendResult } from "../hub-server/types.js";

function socketPath(): string {
  if (process.env.FORGE_HUB_TEST_INJECTOR_SOCKET) return process.env.FORGE_HUB_TEST_INJECTOR_SOCKET;
  const hubDir = process.env.FORGE_HUB_DIR ?? path.join(process.env.HOME ?? "~", ".forge-hub");
  return path.join(hubDir, "injector.sock");
}

let hub: HubAPI;
let ctrlServer: ReturnType<typeof Bun.serve> | null = null;

const plugin: ChannelPlugin = {
  name: "wechat",  // 伪装
  displayName: "Test Injector (fake wechat)",
  aliases: ["wx"],
  capabilities: ["text", "file", "voice"],

  async start(h: HubAPI) {
    hub = h;
    const sock = socketPath();
    // 删旧 socket（残留文件阻止 bind）
    try { fs.unlinkSync(sock); } catch {}

    hub.log(`🧪 test-injector（伪装 wechat）启动，unix socket ${sock}`);

    ctrlServer = Bun.serve({
      unix: sock,
      async fetch(req) {
        const url = new URL(req.url);

        if (req.method === "POST" && url.pathname === "/inject") {
          const body = (await req.json()) as { from?: string; fromId: string; content: string };
          hub.pushMessage({
            channel: "wechat",
            from: body.from ?? "test-owner",
            fromId: body.fromId,
            content: body.content,
            raw: {},
          });
          return Response.json({ ok: true });
        }

        if (req.method === "POST" && url.pathname === "/crash") {
          const body = (await req.json().catch(() => ({}))) as { mode?: string };
          const mode = body.mode ?? "sync";
          if (mode === "sync") {
            setImmediate(() => {
              throw new Error("[test-injector] simulated uncaughtException");
            });
          } else if (mode === "async") {
            void Promise.reject(new Error("[test-injector] simulated unhandledRejection"));
          } else {
            return Response.json({ ok: false, error: `unknown mode: ${mode}` }, { status: 400 });
          }
          return Response.json({ ok: true, mode });
        }

        return new Response("not found", { status: 404 });
      },
    });
  },

  async send(): Promise<SendResult> {
    // no-op——harness 不验证真实 send 出站行为（self-test 关心的是 inbound 处理逻辑）
    return { success: true };
  },

  async stop() {
    if (ctrlServer) {
      ctrlServer.stop();
      ctrlServer = null;
    }
    // 清理 socket 文件
    try { fs.unlinkSync(socketPath()); } catch {}
    hub.log("🧪 test-injector 停止");
  },
};

export default plugin;
