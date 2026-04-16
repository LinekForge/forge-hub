#!/usr/bin/env bun
/**
 * 飞书 stream_recognize ASR · 参考实现（**example，不是 Hub 核心**）
 *
 * 这是一个独立的 Bun 脚本，按 Forge Hub ASR hook 协议调用：
 *   bun feishu-stream-asr.ts <audio_path> <text_output_path> <channel>
 *
 * 用户要启用飞书 native ASR，在自己的 asr-hook.sh 里加一行：
 *   case "$3" in
 *     feishu) exec bun /path/to/examples/feishu-stream-asr.ts "$@" ;;
 *   esac
 *
 * ── 为什么是 example 不是 Hub 内置 ─────────────────────────────────────────
 *
 * 飞书 speech_to_text 原生集成曾短暂进过 feishu.ts（git history 可查），
 * 撤出原因：
 *
 * 1. **Event loop 阻塞风险**：这里用 `execFileSync` 做同步 lark-cli 调用——
 *    60s 音频 = 6 chunks × 每次 2s spawn+API = 累计 12s **完全阻塞调用方的
 *    event loop**。对于 Hub 本体是灾难（期间所有通道 inbound/outbound 停），
 *    对于独立 hook 进程则**只影响 hook 本身**——故障隔离。
 * 2. **飞书 API 细节绑定**：PCM 格式 / base64 / stream_id / sequence_id /
 *    action flag——这些是飞书 specific，放 Hub core 让 Hub 被飞书协议绑架。
 * 3. **承担用户不关心的复杂度**：只用 Telegram + iMessage 的开源用户不应该
 *    为飞书 ASR 代码买单。
 *
 * 所以：机制（ASR hook + plugin.asrTranscribe 可选接口）放 core，策略（飞书
 * stream_recognize 怎么具体调）放 example。想用的人 copy + 改就行。
 *
 * ── 已知限制 ──────────────────────────────────────────────────────────────
 *
 * - **同步 execFile 阻塞**：上面说的。想异步请改成 `await execFileAsync`
 *   (node:util.promisify) 或 `Bun.spawn`——留给你的优化。
 * - **每 tenant 20 并发 streams**：飞书官方限制。单用户不撞。
 * - **chunk 切在 PCM byte offset**：可能切在字中间（最多 1 字偏差 × N chunk）。
 *   飞书 ASR 内部用 stream_id 上下文拼接，一般自愈。casual 语音可接受。
 * - **response shape 未经 success 路径实测**：`callStreamRecognizeChunk` 假设
 *   success = `{ok:true, data:{recognition_text:"..."}}`——只 dry-run 过 error
 *   response（`ok:false`）。如果实际 shape 不同（比如 recognition_text 换名），
 *   `resp.data?.recognition_text ?? ""` fallback 到空串，chunks 全成功但最终
 *   text 为空，exit 1。跑不通时先 log `rawResp` 查实际结构调 parser。
 * - **单 chunk 补发 action=2 close 是假设**（主流程末尾 `if (totalChunks === 1)` 分支）：
 *   不确定飞书 API 接受 `action=2 + empty speech` 关流。实测可能需要改为 action=1
 *   带 full audio 一次到位 或者其他路径。
 *
 * ── 前置要求 ──────────────────────────────────────────────────────────────
 *
 * - lark-cli 已登录（`lark-cli auth status` 绿灯，身份 = bot）
 * - ffmpeg 在 PATH，或设 FORGE_FFMPEG_PATH env 指向绝对路径
 * - Bun >= 1.0
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

// ── 参数解析 ────────────────────────────────────────────────────────────────

const [, , audioPath, outputPath, channel] = process.argv;
if (!audioPath || !outputPath) {
  console.error("Usage: bun feishu-stream-asr.ts <audio_path> <text_output_path> <channel>");
  process.exit(1);
}
if (channel !== "feishu") {
  console.error(`This script is for feishu channel only, got: ${channel}`);
  process.exit(1);
}

// ── 常量 ────────────────────────────────────────────────────────────────────

const LARK_CLI = process.env.FORGE_LARK_CLI
  ?? "/opt/homebrew/lib/node_modules/@larksuite/cli/bin/lark-cli";
const CHUNK_SECONDS = 10;
const PCM_BYTES_PER_SEC = 32000;  // 16kHz × 16-bit × mono
const CHUNK_BYTES = CHUNK_SECONDS * PCM_BYTES_PER_SEC;  // 320 KB
const MIN_PCM_BYTES = 3200;  // 100ms

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolveFfmpeg(): string | null {
  if (process.env.FORGE_FFMPEG_PATH) return process.env.FORGE_FFMPEG_PATH;
  try {
    return execFileSync("/usr/bin/which", ["ffmpeg"], { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

function convertAudioToPcm(audioPath: string): Buffer {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg) {
    throw new Error("找不到 ffmpeg——设 FORGE_FFMPEG_PATH env 或确保 PATH 含 homebrew bin");
  }
  const pcmPath = path.join(os.tmpdir(), `feishu-asr-${Date.now()}-${randomBytes(4).toString("hex")}.pcm`);
  try {
    execFileSync(ffmpeg, [
      "-y", "-i", audioPath,
      "-ar", "16000", "-ac", "1", "-f", "s16le",
      pcmPath,
    ], { timeout: 15000, stdio: "pipe" });
    return fs.readFileSync(pcmPath);
  } finally {
    try { fs.unlinkSync(pcmPath); } catch {}
  }
}

function callStreamRecognizeChunk(
  streamId: string,
  sequenceId: number,
  action: 0 | 1 | 2 | 3,
  chunkBase64: string,
): { ok: boolean; partial?: string; error?: string } {
  const body = JSON.stringify({
    speech: { speech: chunkBase64 },
    config: {
      stream_id: streamId,
      sequence_id: sequenceId,
      action,
      format: "pcm",
      engine_type: "16k_auto",
    },
  });
  const rawResp = execFileSync(LARK_CLI, [
    "api", "POST", "/open-apis/speech_to_text/v1/speech/stream_recognize",
    "--data", body,
    "--as", "bot",
  ], { encoding: "utf-8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const resp = JSON.parse(rawResp) as {
    ok?: boolean;
    data?: { recognition_text?: string };
    error?: { message?: string };
  };
  if (resp.ok === false) {
    return { ok: false, error: resp.error?.message ?? rawResp.slice(0, 200) };
  }
  return { ok: true, partial: resp.data?.recognition_text ?? "" };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const streamId = randomBytes(8).toString("hex");
let openedStream = false;

try {
  const pcmBuf = convertAudioToPcm(audioPath);
  const totalBytes = pcmBuf.length;
  const durationSec = totalBytes / PCM_BYTES_PER_SEC;

  if (totalBytes < MIN_PCM_BYTES) {
    console.error(`[feishu-asr] PCM 过短（${totalBytes} bytes < ${MIN_PCM_BYTES}），跳过`);
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for (let off = 0; off < totalBytes; off += CHUNK_BYTES) {
    chunks.push(pcmBuf.subarray(off, Math.min(off + CHUNK_BYTES, totalBytes)));
  }
  const totalChunks = chunks.length;
  console.error(`[feishu-asr] 识别 ${durationSec.toFixed(1)}s 音频 (${totalChunks} chunks)`);

  const partials: string[] = [];
  let nextSeq = 0;
  for (let i = 0; i < totalChunks; i++) {
    const isFirst = i === 0;
    const isLast = i === totalChunks - 1;
    const action: 0 | 1 | 2 = isFirst ? 1 : (isLast && totalChunks > 1) ? 2 : 0;
    const result = callStreamRecognizeChunk(streamId, nextSeq, action, chunks[i].toString("base64"));
    nextSeq++;
    if (isFirst) openedStream = true;
    if (!result.ok) {
      console.error(`[feishu-asr] chunk ${i + 1}/${totalChunks} 失败: ${result.error}`);
      // abort stream 清 server session（fire-and-forget）
      try { callStreamRecognizeChunk(streamId, 999999, 3, ""); } catch {}
      process.exit(1);
    }
    if (result.partial) partials.push(result.partial);
  }

  // 单 chunk 场景补发 action=2 空包 close stream
  if (totalChunks === 1) {
    const closeResult = callStreamRecognizeChunk(streamId, nextSeq, 2, "");
    if (closeResult.ok && closeResult.partial) partials.push(closeResult.partial);
  }

  const text = partials.join("").trim();
  if (!text) {
    console.error(`[feishu-asr] 所有 ${totalChunks} chunks 识别完但文本为空`);
    process.exit(1);
  }

  fs.writeFileSync(outputPath, text, "utf-8");
  process.exit(0);
} catch (err) {
  console.error(`[feishu-asr] 异常: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  if (openedStream) {
    try { callStreamRecognizeChunk(streamId, 999999, 3, ""); } catch {}
  }
  process.exit(1);
}
