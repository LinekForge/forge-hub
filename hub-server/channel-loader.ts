/**
 * Forge Hub — 通道插件加载器
 *
 * 扫描 channels/ 目录，动态 import，热加载。
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import { CHANNELS_DIR, log, logError, channelLog, channelLogError, formatUnauthorizedNotice as _formatUnauthorizedNotice } from "./config.js";
import { loadChannelState, saveChannelState } from "./state.js";
import type { ChannelPlugin, HubAPI, InboundMessage } from "./types.js";
import type { ChannelSendEntry } from "./channel-registry.js";

// ── State ───────────────────────────────────────────────────────────────────

const plugins = new Map<string, ChannelPlugin>();
const fileToPlugin = new Map<string, string>();  // filePath → pluginName
const fileHashes = new Map<string, string>();
let reloadDebounce: ReturnType<typeof setTimeout> | null = null;

// ── Hash ────────────────────────────────────────────────────────────────────

function fileHash(filePath: string): string {
  try {
    return crypto.createHash("md5").update(fs.readFileSync(filePath, "utf-8")).digest("hex");
  } catch (err) {
    // 返空字符串会让 hash 比对显示"未变" → fs.watch 触发 reload 时 skip 实际损坏的 plugin。
    // 至少 log 让运维查到。
    logError(`fileHash 读失败 ${filePath}: ${String(err)}`);
    return "";
  }
}

// ── HubAPI Factory ──────────────────────────────────────────────────────────

function createHubAPI(channelName: string, onMessage: (msg: InboundMessage) => void): HubAPI {
  return {
    pushMessage(msg: InboundMessage) {
      onMessage(msg);
    },
    getState<T = unknown>(key: string): T | null {
      return loadChannelState(channelName, key) as T | null;
    },
    setState(key: string, value: unknown) {
      saveChannelState(channelName, key, value);
    },
    log(msg: string) {
      channelLog(channelName, msg);
    },
    logError(msg: string) {
      channelLogError(channelName, msg);
    },
    formatUnauthorizedNotice(displayName: string, senderId: string, rawContent: string) {
      // channel 从 closure 取，plugin 不需要传——避免"传错 channel 名 / plugin.name 不一致"的错误机会
      return _formatUnauthorizedNotice(channelName, displayName, senderId, rawContent);
    },
    async resolveAsr(audioPath: string): Promise<string | null> {
      // 动态 import 防 channel-loader 和 asr.ts 的循环依赖（asr.ts 依赖 channel-registry.ts 的 channelPlugins）
      const { resolveAsr } = await import("./asr.js");
      return resolveAsr(channelName, audioPath);
    },
  };
}

// ── Load Single Plugin ──────────────────────────────────────────────────────

const STOP_TIMEOUT_MS = 10_000;

/** 用 timeout 包 stop()——超时就放弃继续，避免一个通道卡死拖垮热重载 */
async function stopWithTimeout(plugin: ChannelPlugin, reason: string): Promise<void> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<void>((_, reject) => {
    t = setTimeout(() => reject(new Error(`stop() timeout > ${STOP_TIMEOUT_MS}ms`)), STOP_TIMEOUT_MS);
  });
  try {
    await Promise.race([plugin.stop(), timeoutPromise]);
  } catch (err) {
    logError(`${reason} 的 stop() 失败/超时: ${String(err)}`);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Load 结果三态：plugin（正常加载）、helper（纯 import module，不算通道）、error（文件存在但读取/import 失败） */
type LoadOutcome =
  | { kind: "plugin"; plugin: ChannelPlugin }
  | { kind: "helper"; reason: string }
  | { kind: "error"; reason: string };

async function loadPlugin(
  filePath: string,
  onMessage: (msg: InboundMessage) => void,
): Promise<LoadOutcome> {
  let mod: { default?: unknown };
  try {
    // Cache-bust for hot reload
    mod = await import(`${filePath}?t=${Date.now()}`);
  } catch (err) {
    return { kind: "error", reason: `import 失败: ${String(err)}` };
  }
  const plugin = mod.default as ChannelPlugin | undefined;

  // Auto-detect plugin shape (redteam A5)——之前按文件名 `-` 黑名单过滤，
  // discord-bot.ts / slack-webhook.ts 这种自然命名直接失踪；改为 auto-detect：
  // export default 不是完整 plugin 就当 helper（像 wechat-ilink.ts 只导出 class）。
  if (!plugin?.name || !plugin?.start || !plugin?.send || !plugin?.stop) {
    return { kind: "helper", reason: "export default 非完整 ChannelPlugin（缺 name/start/send/stop）" };
  }

  const hubAPI = createHubAPI(plugin.name, onMessage);
  // plugin.start() 允许 throw——表示 plugin 无法正常工作（如 telegram 没 bot_token）。
  // throw 后我们不把它加入 sendMap，但 Hub 其他通道照常加载。
  try {
    await plugin.start(hubAPI);
  } catch (err) {
    return { kind: "error", reason: `start() 抛错: ${String(err)}` };
  }
  log(`🔌 通道已加载: ${plugin.name} (${path.basename(filePath)})`);
  return { kind: "plugin", plugin };
}

// ── Load All Plugins ────────────────────────────────────────────────────────

type PluginSend = ChannelPlugin["send"];

interface LoadResult {
  sendMap: Map<string, ChannelSendEntry>;
  metaMap: Map<string, { name: string; displayName: string; aliases: string[] }>;
}

export async function loadChannels(
  onMessage: (msg: InboundMessage) => void,
): Promise<LoadResult> {
  if (!fs.existsSync(CHANNELS_DIR)) {
    fs.mkdirSync(CHANNELS_DIR, { recursive: true });
    return { sendMap: new Map(), metaMap: new Map() };
  }

  // Scan all .ts files (redteam A5)——auto-detect plugin shape instead of
  // filename blacklist. `discord-bot.ts` / `slack-webhook.ts` 这种自然命名
  // 之前被按 `-` 过滤静默失踪；现在每个文件都 import 一遍，只有 export
  // default 是完整 ChannelPlugin 的才注册，其余视作 helper / library module。
  const allFiles = fs.readdirSync(CHANNELS_DIR).filter((f) => f.endsWith(".ts"));

  for (const file of allFiles) {
    const filePath = path.join(CHANNELS_DIR, file);
    const hash = fileHash(filePath);
    fileHashes.set(filePath, hash);

    const outcome = await loadPlugin(filePath, onMessage);
    if (outcome.kind === "plugin") {
      plugins.set(outcome.plugin.name, outcome.plugin);
      fileToPlugin.set(filePath, outcome.plugin.name);
    } else if (outcome.kind === "helper") {
      log(`📄 ${file}: 视为 helper（${outcome.reason}）`);
    } else {
      logError(`加载 ${file} 失败: ${outcome.reason}`);
    }
  }

  // Start hot-reload watcher
  startWatcher(onMessage);

  // Return send-capable map + metadata for hub.ts
  // sendMap uses dynamic lookup so hot-reloaded plugins are used immediately
  // capabilities enforcement：router 层应该先 check plugin.capabilities.includes(type)。
  // 这里包装一层 fallback，即使 router 忘记也给个 consistent 失败（不是崩）——zero trust design
  const sendMap = new Map<string, ChannelSendEntry>();
  const metaMap = new Map<string, { name: string; displayName: string; aliases: string[] }>();
  for (const [name, plugin] of plugins) {
    sendMap.set(name, {
      send: async (p) => {
        const current = plugins.get(name);
        if (!current) return { success: false, error: `通道 ${name} 已卸载` };
        // 强制 capabilities：不在 capabilities 列表的 type 直接拒绝，不调 plugin.send
        if (current.capabilities && current.capabilities.length > 0 && !current.capabilities.includes(p.type as any)) {
          return { success: false, error: `通道 ${name} 不支持 ${p.type}（capabilities: ${current.capabilities.join(",")}）` };
        }
        return current.send(p);
      },
      // Dynamic lookup so hot-reloaded isNativeId picks up (redteam A6)
      isNativeId: (to) => plugins.get(name)?.isNativeId?.(to) ?? false,
      // Dynamic lookup so hot-reloaded asrTranscribe picks up
      asrTranscribe: async (audioPath) => {
        const current = plugins.get(name);
        return current?.asrTranscribe ? current.asrTranscribe(audioPath) : null;
      },
    });
    metaMap.set(name, {
      name: plugin.name,
      displayName: plugin.displayName ?? plugin.name,
      aliases: plugin.aliases ?? [],
    });
  }
  return { sendMap, metaMap };
}

// ── Hot Reload Watcher ──────────────────────────────────────────────────────
//
// Security (redteam B3): fs.watch + dynamic import 是 RCE 入口——任何能写
// CHANNELS_DIR 的 user-level 进程（sandboxed app / compromised other MCP /
// another local user）丢个 .ts 进去 200ms 后以 hub 权限执行。
//
// 防御分两层：
// 1. 默认关闭 hot-reload（此处）。设 FORGE_HUB_DEV=1 才启用，给 plugin 开发者用。
// 2. install 时 CHANNELS_RUNTIME 目录 chmod 700（cli.ts）——non-owner 无法写。
//
// 开发者换插件流程：FORGE_HUB_DEV=1 bun hub.ts（或 plist 设 env 后重启）。
// 生产用户换插件流程：改文件后 launchctl kickstart 重启 hub。

function startWatcher(onMessage: (msg: InboundMessage) => void): void {
  if (process.env.FORGE_HUB_DEV !== "1") {
    log("👁 hot-reload 已关闭（生产模式）。开发模式请设 FORGE_HUB_DEV=1 启动。");
    return;
  }
  try {
    fs.watch(CHANNELS_DIR, async (_event, filename) => {
      if (!filename || !filename.endsWith(".ts")) return;

      if (reloadDebounce) clearTimeout(reloadDebounce);
      reloadDebounce = setTimeout(async () => {
        const filePath = path.join(CHANNELS_DIR, filename);
        const newHash = fileHash(filePath);
        const oldHash = fileHashes.get(filePath);

        // File deleted — only stop the plugin loaded from THIS file
        if (!newHash && oldHash) {
          fileHashes.delete(filePath);
          const pluginName = fileToPlugin.get(filePath);
          if (pluginName) {
            const plugin = plugins.get(pluginName);
            if (plugin) {
              await stopWithTimeout(plugin, `卸载 ${pluginName}`);
              plugins.delete(pluginName);
            }
            fileToPlugin.delete(filePath);
            log(`🔌 通道已卸载: ${pluginName} (${filename} 已删除)`);
          }
          return;
        }

        // No change
        if (newHash === oldHash) return;

        // New or modified
        fileHashes.set(filePath, newHash);

        const outcome = await loadPlugin(filePath, onMessage);
        if (outcome.kind === "plugin") {
          const plugin = outcome.plugin;
          // Stop old version if exists
          const oldName = fileToPlugin.get(filePath);
          const old = oldName ? plugins.get(oldName) : plugins.get(plugin.name);
          if (old) {
            await stopWithTimeout(old, `热重载前停止旧版 ${plugin.name}`);
            if (oldName) plugins.delete(oldName);
            log(`🔄 通道热重载: ${plugin.name}`);
          }
          plugins.set(plugin.name, plugin);
          fileToPlugin.set(filePath, plugin.name);
        } else if (outcome.kind === "helper") {
          log(`📄 ${filename}: 视为 helper（${outcome.reason}）——不重载`);
        } else {
          logError(`热重载 ${filename} 失败: ${outcome.reason}`);
        }
      }, 200);
    });
    log("👁 fs.watch: 监听通道插件目录");
  } catch (err) {
    logError(`fs.watch channels/ 失败: ${String(err)}`);
  }
}

// ── Stop All ────────────────────────────────────────────────────────────────

/**
 * 单通道 restart——watchdog 用。stop → clear stoppedReason → start。
 * 返回 true = 重启成功，false = 失败（plugin 仍在 plugins Map 里但 dead）。
 */
export async function restartPlugin(
  name: string,
  onMessage: (msg: InboundMessage) => void,
): Promise<boolean> {
  const plugin = plugins.get(name);
  if (!plugin) {
    logError(`restartPlugin(${name}): 插件不存在`);
    return false;
  }
  try {
    await stopWithTimeout(plugin, `watchdog restart ${name}`);
    plugin.stoppedReason = undefined; // clear
    const hubAPI = createHubAPI(name, onMessage);
    await plugin.start(hubAPI);
    log(`🔄 watchdog 重启成功: ${name}`);
    return true;
  } catch (err) {
    logError(`watchdog 重启 ${name} 失败: ${String(err)}`);
    return false;
  }
}

/** 获取指定通道 plugin（watchdog 用来读 stoppedReason） */
export function getPlugin(name: string): ChannelPlugin | undefined {
  return plugins.get(name);
}

export async function stopAllChannels(): Promise<void> {
  for (const [name, plugin] of plugins) {
    await stopWithTimeout(plugin, `停止 ${name}`);
    log(`🔌 通道已停止: ${name}`);
  }
  plugins.clear();
}
