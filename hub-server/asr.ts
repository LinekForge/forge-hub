/**
 * Forge Hub — ASR (Automatic Speech Recognition) resolver
 *
 * 入站语音消息 → 这里是 Hub 层统一的识别入口。设计原则和 TTS hook 对称：
 * Hub core **不绑定任何 ASR provider**，用户选择 route：
 *
 *   1. Plugin 自带的 `asrTranscribe` method（如飞书未来版本可接入 speech_to_text API）
 *   2. `FORGE_HUB_ASR_HOOK` env 指向的用户脚本（Whisper / MiniMax / whisper.cpp / 任意）
 *   3. 关闭（agent 只看到 `[语音] ${path}` 占位）
 *
 * 解析顺序：
 *   1. 读 `hub-config.asr_plugin_override[channel]`——用户显式 override：
 *      - "hook" → 强制走 FORGE_HUB_ASR_HOOK（即使 plugin 有 asrTranscribe）
 *      - "none" → 强制关闭 ASR（返 null）
 *   2. 没 override 时：问 plugin 有没有 asrTranscribe
 *   3. 没 plugin 实现 → 跑 FORGE_HUB_ASR_HOOK（如果配了）
 *   4. 都没 → 返 null
 *
 * 用户 hook 协议（和 TTS hook 对称）：
 *   $1 = 音频文件绝对路径（ogg / caf / mp3 / wav 等，各通道格式不一）
 *   $2 = 期望输出的纯文本文件路径（UTF-8）
 *   $3 = 通道名（"wechat" / "telegram" / "feishu" / "imessage"）——hook 可按通道分流 provider
 *   exit 0 且 $2 非空 = 成功；否则失败
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logError } from "./config.js";
import { getCurrentConfig } from "./hub-state.js";
import { channelPlugins } from "./channel-registry.js";
import { execFileText } from "./process-utils.js";

const ASR_HOOK = process.env.FORGE_HUB_ASR_HOOK ?? "";

export async function resolveAsr(channel: string, audioPath: string): Promise<string | null> {
  const override = getCurrentConfig().asr_plugin_override?.[channel];

  // 显式 override 强制走特定路径
  if (override === "none") return null;
  if (override !== "hook") {
    // 没设 override 或 override 是别的值 → 先问 plugin
    const plugin = channelPlugins.get(channel);
    if (plugin?.asrTranscribe) {
      try {
        return await plugin.asrTranscribe(audioPath);
      } catch (err) {
        logError(`[asr] ${channel} plugin.asrTranscribe 失败: ${String(err)}`);
        return null;  // plugin 显式失败不 fallback 到 hook——用户选了 plugin 意味着要 plugin 结果
      }
    }
  }

  // override === "hook" 或 plugin 没实现 → 走用户 hook
  return await runAsrHook(channel, audioPath);
}

async function runAsrHook(channel: string, audioPath: string): Promise<string | null> {
  if (!ASR_HOOK) return null;

  let tmpDir: string;
  try {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hub-asr-"));
    await fs.promises.chmod(tmpDir, 0o700);
  } catch (err) {
    logError(`[asr] 临时目录创建失败: ${String(err)}`);
    return null;
  }

  const textPath = path.join(tmpDir, "out.txt");
  try {
    await execFileText("/bin/bash", [ASR_HOOK, audioPath, textPath, channel], {
      timeout: 30000,
    });
    try {
      await fs.promises.access(textPath, fs.constants.F_OK);
    } catch {
      logError(`[asr] hook 退出成功但未生成 text 文件: hook=${ASR_HOOK} channel=${channel} audio=${audioPath}`);
      return null;
    }
    const text = (await fs.promises.readFile(textPath, "utf-8")).trim();
    if (!text) {
      logError(`[asr] hook 生成的 text 为空: hook=${ASR_HOOK} channel=${channel}`);
      return null;
    }
    return text;
  } catch (err) {
    logError(`[asr] hook 执行失败 (hook=${ASR_HOOK} channel=${channel}): ${String(err)}`);
    return null;
  } finally {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
