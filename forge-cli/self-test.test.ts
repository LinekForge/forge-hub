import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSelfTestHarnessPath } from "./self-test.js";

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "// test harness", "utf-8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("resolveSelfTestHarnessPath", () => {
  test("anchors to forge-cli script directory by default", () => {
    const repoRoot = mkTempDir("forge-hub-self-test-");
    const scriptDir = path.join(repoRoot, "forge-cli");
    const harnessPath = path.join(repoRoot, "hub-test-harness", "harness.ts");
    touch(harnessPath);

    const resolved = resolveSelfTestHarnessPath({
      cwd: "/tmp/ignored-cwd",
      scriptDir,
    });

    expect(resolved.path).toBe(harnessPath);
    expect(resolved.tried[0]).toBe(harnessPath);
  });

  test("supports FORGE_HUB_REPO style root override", () => {
    const repoRoot = mkTempDir("forge-hub-self-test-");
    const harnessPath = path.join(repoRoot, "hub-test-harness", "harness.ts");
    touch(harnessPath);

    const resolved = resolveSelfTestHarnessPath({
      repoRootOverride: repoRoot,
      cwd: "/tmp/ignored-cwd",
      scriptDir: "/tmp/ignored-script-dir",
    });

    expect(resolved.path).toBe(harnessPath);
    expect(resolved.tried).toEqual([harnessPath]);
  });

  test("falls back to cwd when running from repository root", () => {
    const repoRoot = mkTempDir("forge-hub-self-test-");
    const harnessPath = path.join(repoRoot, "hub-test-harness", "harness.ts");
    touch(harnessPath);

    const resolved = resolveSelfTestHarnessPath({
      cwd: repoRoot,
      scriptDir: "/tmp/not-the-repo/forge-cli",
    });

    expect(resolved.path).toBe(harnessPath);
    expect(resolved.tried[1]).toBe(harnessPath);
  });
});
