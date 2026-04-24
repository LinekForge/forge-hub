/**
 * Forge Hub — Hub-wide mutable state
 *
 * `currentConfig` 是 hub-config.json 的内存 live copy——main() 启动时加载，
 * fs.watch 热重载时更新。endpoints / router / approval push 各处都要读最新
 * config。通过 getter 访问避免 stale binding。
 *
 * `startedAt` 是 hub 进程启动的 ISO 时间，给 /health 和 /status 用。
 */

import type { HubConfig } from "./types.js";

export const startedAt = new Date().toISOString();

let _currentConfig: HubConfig | null = null;

export function setCurrentConfig(cfg: HubConfig): void {
  _currentConfig = cfg;
}

export function getCurrentConfig(): HubConfig {
  if (!_currentConfig) throw new Error("hub-state: currentConfig 未初始化（main() 要在 startServer 前 setCurrentConfig）");
  return _currentConfig;
}

// ── Homeland 入站回调 ────────────────────────────────────────────────────

import type { InboundHandleResult, InboundMessage } from "./types.js";

let _onMessage: ((msg: InboundMessage) => InboundHandleResult | Promise<InboundHandleResult>) | null = null;

export function setOnMessage(
  fn: (msg: InboundMessage) => InboundHandleResult | Promise<InboundHandleResult>,
): void {
  _onMessage = fn;
}

export const onMessage = async (msg: InboundMessage): Promise<InboundHandleResult> => {
  if (_onMessage) return await _onMessage(msg);
  return {
    accepted: false,
    reason: "handler_missing",
    detail: "hub onMessage 未注册",
  };
};

// ── Dashboard presence ──────────────────────────────────────────────────

let _dashboardPresence = { lastSeen: new Date(), active: false };

export function setDashboardPresence(active: boolean): void {
  _dashboardPresence = { lastSeen: new Date(), active };
}

export function getDashboardPresence(): { lastSeen: Date; active: boolean } {
  return _dashboardPresence;
}
