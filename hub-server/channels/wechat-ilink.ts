/**
 * ilink API: WeChat ClawBot HTTP interface
 * Adapted for Forge Hub (standalone, no external config dependency)
 */

import crypto from "node:crypto";

import type { GetUpdatesResp, GetConfigResp } from "./wechat-types.js";
import { MSG_TYPE_BOT, MSG_STATE_FINISH, MSG_ITEM_TEXT } from "./wechat-types.js";

// ── Constants ───────────────────────────────────────────────────────────────

const CHANNEL_VERSION = "2.0.0";
const CLIENT_VERSION = String(2 << 16 | 0 << 8 | 0); // 0x00MMNNPP → 131072
const LONG_POLL_TIMEOUT_MS = 35_000;
const TYPING_TIMEOUT_MS = 10_000;
const SEND_CHUNK_LIMIT = 3500;
const RETRY_MAX = 2;
const RETRY_BASE_MS = 1_000;

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

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    const msg = err.message.toLowerCase();
    if (msg.includes("fetch failed") || msg.includes("econnreset") || msg.includes("econnrefused")) return true;
    if (msg.startsWith("http 5")) return true;
  }
  return false;
}

export async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  retries?: number;
}): Promise<{ text: string; status: number }> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const maxRetries = params.retries ?? RETRY_MAX;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
      lastErr = err;
      if (attempt < maxRetries && isRetryable(err)) {
        const delay = RETRY_BASE_MS * (2 ** attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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
      retries: 0,
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

export function chunkText(text: string, limit: number = SEND_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const minSplit = Math.floor(limit * 0.3);
    let cut = window.lastIndexOf("\n\n", limit);
    if (cut < minSplit) cut = window.lastIndexOf("\n", limit);
    if (cut < minSplit) cut = window.lastIndexOf(" ", limit);
    if (cut < minSplit) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export async function sendText(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  const chunks = chunkText(text);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 300));
    const result = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/sendmessage",
      body: JSON.stringify({
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: generateClientId(),
          message_type: MSG_TYPE_BOT,
          message_state: MSG_STATE_FINISH,
          item_list: [{ type: MSG_ITEM_TEXT, text_item: { text: chunks[i] } }],
          context_token: contextToken,
        },
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token,
      timeoutMs: 15_000,
    });
    const resp = JSON.parse(result.text) as { ret?: number; errcode?: number; errmsg?: string };
    const hasError = (resp.ret !== undefined && resp.ret !== 0)
      || (resp.errcode !== undefined && resp.errcode !== 0);
    if (hasError) {
      throw new Error(`sendmessage 失败: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`);
    }
  }
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
