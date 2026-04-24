import fs from "node:fs";

export const DEFAULT_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export class MediaSizeLimitError extends Error {
  constructor(
    readonly label: string,
    readonly actualBytes: number,
    readonly maxBytes = DEFAULT_MEDIA_MAX_BYTES,
  ) {
    super(`${label} 超过媒体大小上限 ${formatMediaSize(maxBytes)}（当前 ${formatMediaSize(actualBytes)}）`);
    this.name = "MediaSizeLimitError";
  }
}

export function formatMediaSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
  }
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function contentLengthBytes(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return bytes;
}

export function assertContentLengthWithinMediaLimit(
  headers: Headers,
  label: string,
  maxBytes = DEFAULT_MEDIA_MAX_BYTES,
): void {
  const bytes = contentLengthBytes(headers);
  if (bytes !== null && bytes > maxBytes) {
    throw new MediaSizeLimitError(label, bytes, maxBytes);
  }
}

export function assertBufferWithinMediaSizeLimit(
  buffer: Buffer | Uint8Array,
  label: string,
  maxBytes = DEFAULT_MEDIA_MAX_BYTES,
): void {
  if (buffer.byteLength > maxBytes) {
    throw new MediaSizeLimitError(label, buffer.byteLength, maxBytes);
  }
}

export async function assertFileWithinMediaSizeLimit(
  filePath: string,
  label: string,
  maxBytes = DEFAULT_MEDIA_MAX_BYTES,
): Promise<void> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size > maxBytes) {
    throw new MediaSizeLimitError(label, stat.size, maxBytes);
  }
}

export async function responseToBufferWithMediaLimit(
  response: Response,
  label: string,
  maxBytes = DEFAULT_MEDIA_MAX_BYTES,
): Promise<Buffer> {
  assertContentLengthWithinMediaLimit(response.headers, label, maxBytes);

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    assertBufferWithinMediaSizeLimit(buffer, label, maxBytes);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new MediaSizeLimitError(label, total, maxBytes);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

export async function writeResponseToFileWithMediaLimit(
  response: Response,
  filePath: string,
  label: string,
  maxBytes = DEFAULT_MEDIA_MAX_BYTES,
): Promise<number> {
  assertContentLengthWithinMediaLimit(response.headers, label, maxBytes);

  let completed = false;
  const handle = await fs.promises.open(filePath, "w", 0o600);
  try {
    if (!response.body) {
      const buffer = Buffer.from(await response.arrayBuffer());
      assertBufferWithinMediaSizeLimit(buffer, label, maxBytes);
      await handle.write(buffer);
      completed = true;
      return buffer.byteLength;
    }

    const reader = response.body.getReader();
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new MediaSizeLimitError(label, total, maxBytes);
      }
      await handle.write(value);
    }
    completed = true;
    return total;
  } finally {
    await handle.close();
    if (!completed) {
      await fs.promises.unlink(filePath).catch(() => {});
    }
  }
}
