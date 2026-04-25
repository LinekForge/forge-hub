/**
 * ilink API: WeChat ClawBot HTTP interface
 * Adapted for Forge Hub (standalone, no external config dependency)
 */

import crypto from "node:crypto";

import type { AccountData, GetUpdatesResp, GetConfigResp } from "./wechat-types.js";
import { MSG_TYPE_BOT, MSG_STATE_FINISH, MSG_ITEM_TEXT } from "./wechat-types.js";

// ── Constants ───────────────────────────────────────────────────────────────

const CHANNEL_VERSION = "2.0.0";
const CLIENT_VERSION = String(2 << 16 | 0 << 8 | 0); // 0x00MMNNPP → 131072
const LONG_POLL_TIMEOUT_MS = 35_000;
const TYPING_TIMEOUT_MS = 10_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

export function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
  if (body) headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

// ── Generic Fetch ───────────────────────────────────────────────────────────

export async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<{ text: string; status: number }> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return { text, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── API Calls ───────────────────────────────────────────────────────────────

export async function getUpdates(
  baseUrl: string,
  token: string,
  syncBuf: string,
): Promise<GetUpdatesResp> {
  try {
    const result = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: syncBuf,
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
    });
    return JSON.parse(result.text) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: syncBuf };
    }
    throw err;
  }
}

export function generateClientId(): string {
  return `forge-hub:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function sendText(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT,
        message_state: MSG_STATE_FINISH,
        item_list: [{ type: MSG_ITEM_TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
}

export async function getConfig(
  baseUrl: string,
  token: string,
  userId: string,
  contextToken?: string,
): Promise<GetConfigResp> {
  const result = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: userId,
      context_token: contextToken ?? "",
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: TYPING_TIMEOUT_MS,
  });
  return JSON.parse(result.text);
}

export async function sendTyping(
  baseUrl: string,
  token: string,
  userId: string,
  typingTicket: string,
  status: number,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: TYPING_TIMEOUT_MS,
  });
}
