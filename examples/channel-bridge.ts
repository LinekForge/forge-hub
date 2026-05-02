#!/usr/bin/env bun
/**
 * Channel Bridge · 跨通道消息桥 示例
 *
 * 通过 Hub WebSocket API 实现双向跨通道消息转发：
 *   - 通道 A 的指定联系人发消息 → 自动转发到通道 B 的指定联系人（加前缀）
 *   - 通道 B 的联系人回复时加特定前缀（如 @Alice） → 转发回通道 A
 *
 * 典型场景：
 *   - Telegram 联系人的消息 → 实时出现在微信对话里
 *   - 微信里用 @Alice 开头回复 → 对方在 Telegram 收到
 *
 * 使用方式：
 *   1. 复制本文件到任意位置，按需修改 CONFIG 配置项
 *   2. 直接运行：bun run channel-bridge.ts
 *   3. 长期后台运行推荐配置 launchd（macOS）或 systemd（Linux）
 *      参考 examples/channel-bridge.plist 的 launchd 示例
 *
 * 依赖：Bun >= 1.0，Hub Server 运行在 localhost:9900（或通过 HUB_URL 环境变量覆盖）
 * 认证：若 Hub 配置了 HUB_API_TOKEN，通过环境变量或 ~/.forge-hub/api-token 文件传入
 */

// 防止系统代理拦截 localhost 请求（参考 hub-channel.ts 的同名处理）
if (!process.env.NO_PROXY) process.env.NO_PROXY = "127.0.0.1,localhost";

import fs from "node:fs";
import path from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  // Hub 地址（通常不需要修改）
  hubUrl: process.env.HUB_URL ?? "http://localhost:9900",

  // 方向 A→B：从哪个通道、哪个联系人，转发到哪里
  a: {
    channel: "telegram",              // 来源通道
    senderId: "YOUR_SENDER_ID_HERE",  // 来源联系人的 sender_id（见下方说明）
    prefix: "【Alice 说：】",          // 转发到 B 时加的前缀
  },

  // 方向 B→A：B 回复时触发转发的前缀
  b: {
    channel: "wechat",                // 目标通道
    senderId: "YOUR_SENDER_ID_HERE",  // 目标联系人的 sender_id
    trigger: "@Alice",                // 微信回复时，以此前缀开头才触发转发（去掉前缀后转发）
  },
};

/**
 * 如何获取 sender_id：
 *   让对方给 Hub bot 发一条消息，Hub 会在日志里打印 sender_id。
 *   也可以查看 ~/.forge-hub/state/<channel>/chat-history.jsonl。
 *
 *   微信：类似 xxxxx@im.wechat
 *   Telegram：纯数字用户 ID，如 123456789
 *   飞书：open_id，类似 ou_xxxxx
 *   iMessage：手机号或邮箱
 */

// ── Auth ──────────────────────────────────────────────────────────────────────

/** 读取 Hub API Token（优先 env，其次 ~/.forge-hub/api-token 文件） */
function readAuthToken(): string {
  if (process.env.HUB_API_TOKEN) return process.env.HUB_API_TOKEN;
  try {
    const tokenFile = path.join(process.env.HOME ?? "~", ".forge-hub", "api-token");
    if (fs.existsSync(tokenFile)) return fs.readFileSync(tokenFile, "utf-8").trim();
  } catch { /* ignore */ }
  return "";
}

const AUTH_TOKEN = readAuthToken();

function authHeaders(): Record<string, string> {
  return AUTH_TOKEN ? { "Authorization": `Bearer ${AUTH_TOKEN}` } : {};
}

// ── Internal ─────────────────────────────────────────────────────────────────

const WS_URL = CONFIG.hubUrl.replace(/^http/, "ws") + "/ws";
const SEND_URL = CONFIG.hubUrl + "/send";
const INSTANCE_ID = "channel-bridge";

// 指数退避参数：5s → 10s → 20s → … → cap 60s，连上后重置
const BACKOFF_INITIAL_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
let reconnectDelay = BACKOFF_INITIAL_MS;

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sendMessage(channel: string, to: string, text: string) {
  const res = await fetch(SEND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ channel, to, text }),
  });
  const body = await res.json() as { success: boolean; error?: string; warning?: string };
  if (!body.success) {
    log(`发送失败 [${channel}→${to}]: ${body.error ?? "unknown error"}`);
  } else {
    if (body.warning) log(`警告 [${channel}]: ${body.warning}`);
    log(`→ [${channel}] ${to.slice(0, 12)}…: ${text.slice(0, 60)}`);
  }
}

function connect() {
  const wsUrl = AUTH_TOKEN
    ? `${WS_URL}?instance=${INSTANCE_ID}&token=${AUTH_TOKEN}`
    : `${WS_URL}?instance=${INSTANCE_ID}`;

  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    reconnectDelay = BACKOFF_INITIAL_MS; // 连上后重置退避
    log("已连接到 Hub");
    ws.send(JSON.stringify({ type: "ready", tag: INSTANCE_ID }));
    log(`监听 [${CONFIG.a.channel}] sender=${CONFIG.a.senderId}`);
    log(`监听 [${CONFIG.b.channel}] sender=${CONFIG.b.senderId} trigger="${CONFIG.b.trigger}"`);
  };

  ws.onmessage = async (event) => {
    let msg: { type: string; channel: string; fromId: string; content: string };
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }

    if (msg.type !== "message") return;

    // A → B
    if (msg.channel === CONFIG.a.channel && msg.fromId === CONFIG.a.senderId) {
      const text = `${CONFIG.a.prefix}${msg.content}`;
      log(`← [${CONFIG.a.channel}] 收到，转发到 [${CONFIG.b.channel}]`);
      await sendMessage(CONFIG.b.channel, CONFIG.b.senderId, text);
      return;
    }

    // B → A（需要 trigger 前缀）
    if (
      msg.channel === CONFIG.b.channel &&
      msg.fromId === CONFIG.b.senderId &&
      msg.content.startsWith(CONFIG.b.trigger)
    ) {
      const text = msg.content.slice(CONFIG.b.trigger.length).trimStart();
      log(`← [${CONFIG.b.channel}] 触发转发到 [${CONFIG.a.channel}]`);
      await sendMessage(CONFIG.a.channel, CONFIG.a.senderId, text);
    }
  };

  ws.onerror = (e) => {
    log(`WebSocket 错误: ${String(e)}`);
  };

  ws.onclose = () => {
    log(`连接断开，${reconnectDelay / 1000}s 后重连…`);
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, BACKOFF_MAX_MS);
      connect();
    }, reconnectDelay);
  };
}

log("Channel Bridge 启动");
connect();
