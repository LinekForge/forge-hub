import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertRealPathInsideDir, sanitizeMediaFileName } from "./media-path.js";

describe("media path helpers", () => {
  test("sanitizes external attachment names to a timestamped basename", () => {
    expect(sanitizeMediaFileName("../secret.txt", 123)).toBe("123-secret.txt");
    expect(sanitizeMediaFileName("nested\\evil\u0000name.pdf", 123)).toBe("123-nested_evil_name.pdf");
    expect(sanitizeMediaFileName("..", 123)).toBe("123-file");
    expect(sanitizeMediaFileName("", 123)).toBe("123-file");
  });

  test("rejects real paths outside the media directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-media-"));
    try {
      const mediaDir = path.join(root, "media");
      fs.mkdirSync(mediaDir, { recursive: true });
      const inside = path.join(mediaDir, "ok.txt");
      fs.writeFileSync(inside, "ok");
      await expect(assertRealPathInsideDir(mediaDir, inside)).resolves.toBeUndefined();

      const outside = path.join(root, "outside.txt");
      fs.writeFileSync(outside, "no");
      await expect(assertRealPathInsideDir(mediaDir, outside)).rejects.toThrow("escaped");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
