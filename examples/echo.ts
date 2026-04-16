/**
 * Echo Channel · Forge Hub 最小示例插件
 *
 * 不依赖任何外部平台——起一个本地 HTTP server：
 *   POST /inbound    { fromId, from, content }   → hub.pushMessage
 *   send(...)        → 写 /tmp/echo-channel-out.log
 *
 * 目的：让外部贡献者在半小时内跑通"入站 → 出站"链路，
 * 无需申请 API key、无需连真实平台。
 *
 * 部署到运行时（文件名随意——loader 走 auto-detect plugin shape，
 * export default 不是完整 ChannelPlugin 会被视为 helper module）：
 *   cp examples/echo.ts ~/.forge-hub/channels/echo.ts
 *
 * 参考 hub-docs/channel-plugin-guide.md 的完整解释。
 */

import fs from "node:fs";
import type { ChannelPlugin, HubAPI, SendParams, SendResult, Allowlist } from "../hub-server/types.js";

const PORT = 8787;
const OUT_LOG = "/tmp/echo-channel-out.log";

// 模块级状态——start 时赋值，stop 时清理。
// 热重载会 new 一个模块实例，旧的靠 stop() 释放 server / timer。
let hub: HubAPI;
let server: ReturnType<typeof Bun.serve> | null = null;

// ── Allowlist（约定 schema，见 guide §4） ─────────────────────────────────────

// Allowlist schema 是所有通道统一的——从 types.ts import 而非本地定义。见 guide §4。

function getAllowlist(): Allowlist {
  // 用 getState<T> 泛型避免手动 cast
  return hub.getState<Allowlist>("allowlist") ?? { allowed: [], auto_allow_next: false };
}

function isAllowed(senderId: string): boolean {
  return getAllowlist().allowed.some((e) => e.id === senderId);
}

function getNickname(senderId: string): string {
  return getAllowlist().allowed.find((e) => e.id === senderId)?.nickname ?? senderId;
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const plugin: ChannelPlugin = {
  name: "echo",
  displayName: "Echo",
  aliases: ["e"],
  capabilities: ["text", "file"],

  async start(hubAPI) {
    hub = hubAPI;

    // 起一个 bun HTTP server 模拟外部平台 webhook
    server = Bun.serve({
      port: PORT,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/inbound" && req.method === "POST") {
          let body: { fromId?: string; from?: string; content?: string };
          try {
            body = await req.json() as typeof body;
          } catch {
            return new Response("bad json", { status: 400 });
          }

          const senderId = body.fromId ?? "unknown";
          const displayName = body.from ?? senderId;
          const content = body.content ?? "";
          if (!content) return new Response("empty content", { status: 400 });

          // 非主人处理——见 guide §4
          if (!isAllowed(senderId)) {
            hub.logError(`⛔ 拒绝未授权: ${senderId}, 原文前 50: "${content.slice(0, 50)}"`);
            hub.pushMessage({
              channel: "echo",
              from: "system",
              fromId: "system",
              content: hub.formatUnauthorizedNotice(displayName, senderId, content),
              raw: {},
            });
            return new Response("blocked", { status: 403 });
          }

          const nick = getNickname(senderId);
          hub.log(`← ${nick}: ${content.slice(0, 80)}`);
          hub.pushMessage({
            channel: "echo",
            from: nick,
            fromId: senderId,
            content,
            raw: { received_at: Date.now() },
          });
          return new Response("ok");
        }

        if (url.pathname === "/health") {
          return new Response(JSON.stringify({ channel: "echo", port: PORT }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response("not found", { status: 404 });
      },
    });

    hub.log(`Echo server listening on :${PORT} (POST /inbound)`);
    hub.log(`出站会写入 ${OUT_LOG}`);
  },

  async send({ to, content, type, filePath }: SendParams): Promise<SendResult> {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        to,
        type,
        content: content.slice(0, 200),
        filePath: filePath ?? null,
      }) + "\n";

      if (type === "text" || type === "file") {
        fs.appendFileSync(OUT_LOG, line);
        hub.log(`→ ${to}: [${type}] ${content.slice(0, 60)}`);
        return { success: true };
      }

      return { success: false, error: `echo 不支持 type=${type}` };
    } catch (err) {
      hub.logError(`echo.send 失败: ${String(err)}`);
      return { success: false, error: String(err) };
    }
  },

  async stop() {
    if (server) {
      server.stop(true);
      server = null;
    }
    hub?.log("Echo server 已停止");
  },
};

export default plugin;
