import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { downloadMediaItem } from "./channels/wechat-media.js";
import type { MessageItem } from "./channels/wechat-types.js";

const tempDirs: string[] = [];
const originalFetch = globalThis.fetch;

function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function encryptAes128Ecb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("downloadMediaItem", () => {
  test("sanitizes WeChat file names and keeps writes inside media dir", async () => {
    const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const plaintext = Buffer.from("payload");
    const encrypted = encryptAes128Ecb(plaintext, key);
    globalThis.fetch = (async () => new Response(Uint8Array.from(encrypted).buffer)) as unknown as typeof fetch;

    const root = mkTempDir("forge-hub-wechat-media-");
    const mediaDir = path.join(root, "media");
    const item: MessageItem = {
      type: 4,
      file_item: {
        file_name: "../../secret.txt",
        media: {
          encrypt_query_param: "download-token",
          aes_key: key.toString("hex"),
        },
      },
    };

    const media = await downloadMediaItem(item, mediaDir);

    expect(media).not.toBeNull();
    expect(media!.fileName).toMatch(/^\d+-secret\.txt$/);
    expect(path.dirname(media!.filePath)).toBe(mediaDir);
    expect(fs.readFileSync(media!.filePath, "utf-8")).toBe("payload");
    expect(fs.existsSync(path.join(root, "secret.txt"))).toBe(false);
  });
});
