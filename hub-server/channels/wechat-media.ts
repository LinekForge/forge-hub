/**
 * WeChat 媒体上传 + 语音合成
 * 从原 wechat-channel/media.ts 迁移，适配 Hub 架构。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { apiFetch, generateClientId } from "./wechat-ilink.js";
import { MSG_TYPE_BOT, MSG_STATE_FINISH } from "./wechat-types.js";
import { execFileText } from "../process-utils.js";
import { assertRealPathInsideDir, sanitizeMediaFileName } from "../media-path.js";

// ── Constants ───────────────────────────────────────────────────────────────

const CHANNEL_VERSION = "0.2.0";
const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
const CDN_UPLOAD_URL = `${CDN_BASE}/upload`;
const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

const CDN_DOWNLOAD_URL = `${CDN_BASE}/download`;

// TTS hook：和 hub.ts 一致的协议——$1=text，$2=输出 mp3 路径。
// 配 `FORGE_HUB_TTS_HOOK` env var 指向任意 TTS shell 脚本（MiniMax / ElevenLabs / etc）。
// 未配置 = 微信语音发送不可用。
const TTS_HOOK = process.env.FORGE_HUB_TTS_HOOK ?? "";

// ── AES Helpers ─────────────────────────────────────────────────────────────

function decryptAes128Ecb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ── AES Key Parsing ─────────────────────────────────────────────────────────

function parseAesKey(hexOrBase64: string): Buffer {
  if (/^[0-9a-fA-F]{32}$/.test(hexOrBase64)) return Buffer.from(hexOrBase64, "hex");
  const decoded = Buffer.from(hexOrBase64, "base64");
  const decodedStr = decoded.toString("utf-8");
  if (/^[0-9a-fA-F]{32}$/.test(decodedStr)) return Buffer.from(decodedStr, "hex");
  return decoded.subarray(0, 16);
}

// ── CDN Download ────────────────────────────────────────────────────────────

async function cdnDownload(encryptedQueryParam: string): Promise<Buffer> {
  const url = `${CDN_DOWNLOAD_URL}?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
  const MAX_RETRIES = 3;
  const startTime = Date.now();
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => "(no body)");
        const headers = Object.fromEntries(res.headers.entries());
        process.stderr.write(`[wechat-media] CDN ${res.status} #${attempt + 1}/${MAX_RETRIES} · elapsed ${Date.now() - startTime}ms · headers: ${JSON.stringify(headers).slice(0, 200)} · body: ${body.slice(0, 100)}\n`);
        if (res.status >= 500 && attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw new Error(`CDN download failed: ${res.status}`);
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_RETRIES - 1 && String(err).includes("500")) continue;
      process.stderr.write(`[wechat-media] CDN 最终失败 · ${MAX_RETRIES} 次重试 · 总耗时 ${Date.now() - startTime}ms · ${String(err)}\n`);
      throw err;
    }
  }
  throw new Error("CDN download failed after retries");
}

// ── Image Extension Detection ───────────────────────────────────────────────

function detectImageExt(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "webp";
  return "jpg";
}

// ── Media Download ──────────────────────────────────────────────────────────

interface MessageItem {
  type?: number;
  image_item?: { media?: { encrypt_query_param?: string; aes_key?: string }; aeskey?: string };
  voice_item?: { media?: { encrypt_query_param?: string; aes_key?: string }; text?: string };
  file_item?: { media?: { encrypt_query_param?: string; aes_key?: string }; file_name?: string };
  video_item?: { media?: { encrypt_query_param?: string; aes_key?: string } };
}

export interface DownloadedMedia {
  type: "image" | "voice" | "file" | "video";
  filePath: string;
  fileName: string;
}

export async function downloadMediaItem(item: MessageItem, mediaDir: string): Promise<DownloadedMedia | null> {
  try {
    const ts = Date.now();
    await fs.promises.mkdir(mediaDir, { recursive: true });

    // Image
    if (item.type === 2 && item.image_item) {
      const queryParam = item.image_item.media?.encrypt_query_param;
      const keyStr = item.image_item.aeskey || item.image_item.media?.aes_key;
      if (!queryParam || !keyStr) return null;
      const encrypted = await cdnDownload(queryParam);
      const decrypted = decryptAes128Ecb(encrypted, parseAesKey(keyStr));
      const ext = detectImageExt(decrypted);
      const fileName = `img_${ts}.${ext}`;
      const filePath = path.join(mediaDir, fileName);
      await fs.promises.writeFile(filePath, decrypted);
      return { type: "image", filePath, fileName };
    }

    // File
    if (item.type === 4 && item.file_item) {
      const queryParam = item.file_item.media?.encrypt_query_param;
      const keyStr = item.file_item.media?.aes_key;
      if (!queryParam || !keyStr) return null;
      const encrypted = await cdnDownload(queryParam);
      const decrypted = decryptAes128Ecb(encrypted, parseAesKey(keyStr));
      const origName = item.file_item.file_name || `file_${ts}`;
      const fileName = sanitizeMediaFileName(origName, ts);
      const filePath = path.join(mediaDir, fileName);
      await fs.promises.writeFile(filePath, decrypted);
      await assertRealPathInsideDir(mediaDir, filePath);
      return { type: "file", filePath, fileName };
    }

    // Video
    if (item.type === 5 && item.video_item) {
      const queryParam = item.video_item.media?.encrypt_query_param;
      const keyStr = item.video_item.media?.aes_key;
      if (!queryParam || !keyStr) return null;
      const encrypted = await cdnDownload(queryParam);
      const decrypted = decryptAes128Ecb(encrypted, parseAesKey(keyStr));
      const fileName = `video_${ts}.mp4`;
      const filePath = path.join(mediaDir, fileName);
      await fs.promises.writeFile(filePath, decrypted);
      return { type: "video", filePath, fileName };
    }

    // Voice
    if (item.type === 3 && item.voice_item?.media) {
      const queryParam = item.voice_item.media.encrypt_query_param;
      const keyStr = item.voice_item.media.aes_key;
      if (!queryParam || !keyStr) return null;
      const encrypted = await cdnDownload(queryParam);
      const decrypted = decryptAes128Ecb(encrypted, parseAesKey(keyStr));
      const fileName = `voice_${ts}.silk`;
      const filePath = path.join(mediaDir, fileName);
      await fs.promises.writeFile(filePath, decrypted);
      return { type: "voice", filePath, fileName };
    }
  } catch (err) {
    process.stderr.write(`[wechat-media] 下载失败: ${String(err)}\n`);
    return null;
  }
  return null;
}

// ── MIME Detection ──────────────────────────────────────────────────────────

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimes: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp",
    ".mp4": "video/mp4", ".mov": "video/quicktime",
    ".pdf": "application/pdf", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip", ".txt": "text/plain", ".md": "text/markdown",
  };
  return mimes[ext] || "application/octet-stream";
}

// ── Upload + Send Media ─────────────────────────────────────────────────────

export async function uploadAndSendMedia(
  baseUrl: string,
  token: string,
  to: string,
  filePath: string,
  contextToken: string,
  mediaDir: string,
): Promise<void> {
  // Handle URL downloads
  let localPath = filePath;
  if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
    const res = await fetch(filePath, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") || "";
    const ctExtMap: Record<string, string> = {
      "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif",
      "image/webp": ".webp", "video/mp4": ".mp4", "audio/mpeg": ".mp3",
      "application/pdf": ".pdf",
    };
    const ctExt = Object.entries(ctExtMap).find(([ct]) => contentType.includes(ct))?.[1];
    const urlExt = path.extname(new URL(filePath).pathname);
    const ext = ctExt || (urlExt && urlExt !== "" ? urlExt : ".bin");
    localPath = path.join(mediaDir, `dl_${Date.now()}${ext}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(localPath, buf);
  }

  try {
    await fs.promises.access(localPath, fs.constants.F_OK);
  } catch {
    throw new Error(`文件不存在: ${localPath}`);
  }

  const plaintext = await fs.promises.readFile(localPath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const mime = getMimeType(localPath);
  let uploadMediaType: number;
  let itemType: number;

  if (mime.startsWith("image/")) {
    uploadMediaType = UPLOAD_MEDIA_TYPE.IMAGE;
    itemType = 2;
  } else if (mime.startsWith("video/")) {
    uploadMediaType = UPLOAD_MEDIA_TYPE.VIDEO;
    itemType = 5;
  } else {
    uploadMediaType = UPLOAD_MEDIA_TYPE.FILE;
    itemType = 4;
  }

  // Step 1: Get upload URL
  const uploadUrlResp = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      filekey, media_type: uploadMediaType, to_user_id: to,
      rawsize, rawfilemd5, filesize, no_need_thumb: true,
      aeskey: aeskey.toString("hex"),
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
  const uploadUrlData = JSON.parse(uploadUrlResp.text) as { upload_param?: string };
  if (!uploadUrlData.upload_param) throw new Error("getuploadurl 未返回 upload_param");

  // Step 2: Encrypt and upload to CDN
  const ciphertext = encryptAesEcb(plaintext, aeskey);
  const cdnUrl = `${CDN_UPLOAD_URL}?encrypted_query_param=${encodeURIComponent(uploadUrlData.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  const cdnRes = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!cdnRes.ok) throw new Error(`CDN 上传失败: ${cdnRes.status}`);
  const downloadParam = cdnRes.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error("CDN 响应缺少 x-encrypted-param");

  // Step 3: Send message with media reference
  const aesKeyBase64 = Buffer.from(aeskey.toString("hex")).toString("base64");
  const mediaRef = { encrypt_query_param: downloadParam, aes_key: aesKeyBase64, encrypt_type: 1 };

  let mediaItem: Record<string, unknown>;
  if (itemType === 2) {
    mediaItem = { type: 2, image_item: { media: mediaRef, mid_size: filesize } };
  } else if (itemType === 5) {
    mediaItem = { type: 5, video_item: { media: mediaRef, video_size: filesize } };
  } else {
    mediaItem = { type: 4, file_item: { media: mediaRef, file_name: path.basename(localPath), len: String(rawsize) } };
  }

  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "", to_user_id: to,
        client_id: generateClientId(),
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [mediaItem], context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token,
    timeoutMs: 15_000,
  });
}

// ── Voice Send (TTS → mp3 → file attachment) ────────────────────────────────

/**
 * TTS → mp3 → 作为**文件附件**发送到微信。
 *
 * 微信 iLink 插件协议**不接受原生 silk 语音**：`sendmessage` 接受 silk voice_item
 * 但静默吞（Hub 侧认为成功，用户微信里收不到）。这是 iLink 插件自身的限制，
 * 不是本项目实现问题——尝试过完整 silk-wasm encode + voice_item payload，
 * 不通。所以微信出站语音统一降级为 mp3 file attachment：用户微信里看到
 * 一个 `.mp3` 文件，点开能听，**非原生语音条**。
 *
 * 其他通道（Telegram / 飞书）走 Hub 层 ogg/opus 原生语音条，不走这里——
 * 见 `endpoints.ts` 的 `/send-voice` handler 里的 `body.channel === "wechat"` 分支。
 */
export async function sendTtsAsMp3File(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
  mediaDir: string,
): Promise<void> {
  if (!TTS_HOOK) {
    throw new Error("FORGE_HUB_TTS_HOOK 未配置——语音发送需要 TTS hook。详见 hub-server/tts.ts 协议注释");
  }
  const ts = Date.now();
  const mp3Path = path.join(mediaDir, `voice_out_${ts}.mp3`);
  await fs.promises.mkdir(mediaDir, { recursive: true });
  // 和 tts.ts / asr.ts 统一：明确 /bin/bash 避免 PATH 劫持，30s timeout 覆盖常见 TTS API
  await execFileText("/bin/bash", [TTS_HOOK, text, mp3Path], { timeout: 30_000 });
  try {
    await fs.promises.access(mp3Path, fs.constants.F_OK);
  } catch {
    throw new Error(`TTS hook 未生成 mp3: ${TTS_HOOK}`);
  }
  try {
    // uploadAndSendMedia 按 mime 自动把 mp3 判成 itemType=4 file，发成文件附件
    await uploadAndSendMedia(baseUrl, token, to, mp3Path, contextToken, mediaDir);
  } finally {
    try { await fs.promises.unlink(mp3Path); } catch {}
  }
}
