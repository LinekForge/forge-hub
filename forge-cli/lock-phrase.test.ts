import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("fh hub set-lock-phrase", () => {
  test("writes lock phrase into FORGE_HUB_DIR with sensitive permissions", async () => {
    const hubDir = mkTempDir("forge-hub-cli-hub-");
    const homeDir = mkTempDir("forge-hub-cli-home-");
    const script = path.join(import.meta.dir, "forge.ts");

    const proc = Bun.spawn([
      process.execPath,
      script,
      "hub",
      "set-lock-phrase",
      "sesame",
    ], {
      env: {
        ...process.env,
        FORGE_HUB_DIR: hubDir,
        HOME: homeDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await proc.exited).toBe(0);
    const phraseFile = path.join(hubDir, "lock-phrase.json");
    const data = JSON.parse(fs.readFileSync(phraseFile, "utf-8")) as { phrase: string };
    expect(data.phrase).toBe("sesame");
    expect(fs.statSync(hubDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(phraseFile).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(homeDir, ".forge-hub", "lock-phrase.json"))).toBe(false);
  });
});
