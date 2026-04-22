/**
 * Forge Hub — Hub-level TTS
 *
 * 语音合成是**可选 feature**。用户需要语音发送时，配置一个 TTS hook 脚本——
 * 接收 text + 输出 mp3 路径作为参数，把合成的 mp3 写到指定路径。
 * 例子：MiniMax / ElevenLabs / Azure TTS / OpenAI TTS 都可以包成 shell 脚本。
 *
 * 配置方式：
 *   - `FORGE_HUB_TTS_HOOK` env var (优先) — 绝对路径
 *   - 不配置 = 语音功能关闭，`/send-voice` 返 501 不可用错误
 *
 * Hook 协议：
 *   $1 = 要合成的文本（UTF-8）
 *   $2 = 期望输出的 mp3 绝对路径（Hub 会检查此文件是否生成）
 *   exit 0 且 $2 文件存在 = 合成成功
 *   任何其他情况 = 失败
 *
 * ffmpeg 路径：优先 env `FORGE_FFMPEG_PATH`，否则 which 动态找。
 * Intel Mac / Linux / 自定义 Homebrew prefix 用户自行设 env。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { logError, resolveFfmpeg } from "./config.js";
import { execFileText } from "./process-utils.js";

const TTS_HOOK = process.env.FORGE_HUB_TTS_HOOK ?? "";

export async function synthesizeToOgg(text: string): Promise<string | null> {
  if (!TTS_HOOK) {
    logError("TTS 未配置：设置 FORGE_HUB_TTS_HOOK env var 指向你的 TTS 脚本（协议见 tts.ts 顶部注释）");
    return null;
  }
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    logError("找不到 ffmpeg：请 `brew install ffmpeg` 或设 FORGE_FFMPEG_PATH env var 指向绝对路径");
    return null;
  }

  // redteam r2 M3: `/tmp/hub_voice_${Date.now()}.mp3` 路径可预测 + /tmp
  // world-writable → 本机 attacker 可预埋 symlink 指向 victim 文件，诱导用户
  // TTS hook 的 `>` 重定向或 ffmpeg -y 覆盖写任意位置（authorized_keys 等）。
  // 用 mkdtempSync 创建 owner-only 0o700 目录——路径含 OS 随机后缀，attacker
  // 无法预猜也无法预埋 symlink。返回 ogg 后调用方清理父目录。
  let tmpDir: string;
  try {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hub-tts-"));
    await fs.promises.chmod(tmpDir, 0o700);
  } catch (err) {
    logError(`TTS 临时目录创建失败: ${String(err)}`);
    return null;
  }
  const mp3 = path.join(tmpDir, "v.mp3");
  const ogg = path.join(tmpDir, "v.ogg");

  try {
    await execFileText("/bin/bash", [TTS_HOOK, text, mp3], { timeout: 15000 });
    try {
      await fs.promises.access(mp3, fs.constants.F_OK);
    } catch {
      logError(`TTS hook 返回成功但 mp3 文件未生成: ${TTS_HOOK}`);
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
      return null;
    }
    await execFileText(ffmpeg, ["-y", "-i", mp3, "-c:a", "libopus", "-b:a", "64k", ogg], { timeout: 10000 });
    try { await fs.promises.unlink(mp3); } catch {}
    try {
      await fs.promises.access(ogg, fs.constants.F_OK);
    } catch {
      // ffmpeg exit 0 但 ogg 文件未生成（罕见；codec 错误 / 磁盘满 / 权限等）。
      // 不打 log 的话上游只看到"TTS 合成失败"泛指——debug 无 evidence。
      logError(`ffmpeg 退出成功但 ogg 未生成: ffmpeg=${ffmpeg}, mp3=${mp3}, ogg=${ogg}`);
      try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
      return null;
    }
    return ogg;
  } catch (err) {
    logError(`TTS 合成失败 (hook=${TTS_HOOK}, ffmpeg=${ffmpeg}): ${String(err)}`);
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
    return null;
  }
}
