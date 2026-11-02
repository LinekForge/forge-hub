import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cleanDirContents, HUB_INSTALL_PRESERVE_ENTRIES, syncApiTokenFileAt, waitUntil } from "./cli.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("install runtime preservation", () => {
  test("preserves security evidence, events, and audit materials", () => {
    const preservedEntries = [
      "state",
      "evidence",
      "security-events.jsonl",
      "audit.jsonl",
      "api-token",
    ];
    for (const entry of preservedEntries) {
      const p = path.join(tmpDir, entry);
      if (entry.includes(".")) {
        fs.writeFileSync(p, entry);
      } else {
        fs.mkdirSync(p, { recursive: true });
      }
    }
    fs.writeFileSync(path.join(tmpDir, "old-runtime.ts"), "remove me");

    cleanDirContents(tmpDir, new Set(HUB_INSTALL_PRESERVE_ENTRIES));

    for (const entry of preservedEntries) {
      expect(fs.existsSync(path.join(tmpDir, entry))).toBe(true);
    }
    expect(fs.existsSync(path.join(tmpDir, "old-runtime.ts"))).toBe(false);
  });
});

describe("syncApiTokenFileAt", () => {
  test("atomically replaces an existing regular token file", () => {
    const tokenFile = path.join(tmpDir, "api-token");
    fs.writeFileSync(tokenFile, "old-token", { mode: 0o600 });

    syncApiTokenFileAt({
      hubDir: tmpDir,
      apiTokenFile: tokenFile,
      token: "new-token",
    });

    expect(fs.readFileSync(tokenFile, "utf-8")).toBe("new-token");
    expect(fs.lstatSync(tokenFile).isFile()).toBe(true);
    expect(fs.statSync(tokenFile).mode & 0o077).toBe(0);
  });

  test("replaces a symlink itself without writing through it", () => {
    const tokenFile = path.join(tmpDir, "api-token");
    const attackerTarget = path.join(tmpDir, "attacker-target");
    fs.symlinkSync(attackerTarget, tokenFile);

    syncApiTokenFileAt({
      hubDir: tmpDir,
      apiTokenFile: tokenFile,
      token: "safe-token",
    });

    expect(fs.lstatSync(tokenFile).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(tokenFile, "utf-8")).toBe("safe-token");
    expect(fs.existsSync(attackerTarget)).toBe(false);
  });
});

describe("waitUntil", () => {
  test("returns true immediately when the predicate already holds", async () => {
    let calls = 0;
    const ok = await waitUntil(() => { calls += 1; return true; }, 1000, 10);

    expect(ok).toBe(true);
    expect(calls).toBe(1); // 已经成立就不该再轮询
  });

  test("returns true once the predicate flips partway through", async () => {
    let n = 0;
    const ok = await waitUntil(() => (n += 1) >= 3, 1000, 5);

    expect(ok).toBe(true);
    expect(n).toBe(3);
  });

  test("returns false when the predicate never holds before the timeout", async () => {
    const ok = await waitUntil(() => false, 60, 10);

    expect(ok).toBe(false); // 超时必须能报失败——否则调用方会把"没等到"当成"成功了"
  });

  test("awaits async predicates", async () => {
    let n = 0;
    const ok = await waitUntil(async () => (n += 1) >= 2, 1000, 5);

    expect(ok).toBe(true);
    expect(n).toBe(2);
  });
});
