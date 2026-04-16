/**
 * Forge Hub — Channel Watchdog（通道恢复探针）
 *
 * 每 WATCHDOG_INTERVAL_MS 检查所有通道：
 * - unhealthy + 有 stoppedReason + reason 在 RESTARTABLE set → stop + start 重启
 * - auth / config 错误 → 不重启（需人改配置）
 * - 飞书有自重启机制——如果飞书自己恢复了（healthy），watchdog 不干预
 *
 * 新通道自动获得恢复能力——只要实现了 start()/stop() + 写 stoppedReason 就行。
 */

import { log, logError, deriveHealthStatus, getChannelHealth } from "./config.js";
import { channelPlugins } from "./channel-registry.js";
import { getPlugin, restartPlugin } from "./channel-loader.js";
import { RESTARTABLE_REASONS } from "./types.js";
import type { InboundMessage } from "./types.js";

const WATCHDOG_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * 启动 watchdog 定时器。main() 在 loadChannels 之后调用。
 * @param onMessage hub 的 onMessage 入口——restart 时传给 plugin.start(hubAPI)
 */
export function startChannelWatchdog(onMessage: (msg: InboundMessage) => void): void {
  setInterval(async () => {
    for (const [name] of channelPlugins) {
      const plugin = getPlugin(name);
      if (!plugin) continue;

      const health = getChannelHealth(name);
      const status = deriveHealthStatus(health);

      // 只关心 unhealthy + 有停止原因的通道
      if (status !== "unhealthy") continue;
      if (!plugin.stoppedReason) continue;

      // auth / config → 不重启
      if (!RESTARTABLE_REASONS.has(plugin.stoppedReason)) {
        // 只在第一次见到时 log，避免每 2 分钟重复
        continue;
      }

      log(`🔧 watchdog: 通道 ${name} unhealthy (reason=${plugin.stoppedReason})，尝试 restart...`);
      const ok = await restartPlugin(name, onMessage);
      if (ok) {
        log(`✅ watchdog: ${name} 重启成功`);
      } else {
        logError(`⚠️ watchdog: ${name} 重启失败，下个周期再试`);
      }
    }
  }, WATCHDOG_INTERVAL_MS);

  log(`🐕 channel watchdog 已启动（每 ${WATCHDOG_INTERVAL_MS / 1000}s 检查 unhealthy 通道）`);
}
