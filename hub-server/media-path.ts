import fs from "node:fs";
import path from "node:path";

const CONTROL_OR_SEPARATOR_RE = /[\x00-\x1F\x7F/\\]/g;

export function sanitizeMediaFileName(input: string | undefined, now = Date.now()): string {
  const rawBase = path.basename(input?.trim() || "file");
  const cleaned = rawBase
    .replace(CONTROL_OR_SEPARATOR_RE, "_")
    .replace(/^\.+$/, "file")
    .trim();
  return `${now}-${cleaned || "file"}`;
}

export async function assertRealPathInsideDir(parentDir: string, filePath: string): Promise<void> {
  const [realParent, realFile] = await Promise.all([
    fs.promises.realpath(parentDir),
    fs.promises.realpath(filePath),
  ]);
  const relative = path.relative(realParent, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new Error(`media file escaped ${parentDir}: ${filePath}`);
  }
}
