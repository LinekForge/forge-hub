import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, test } from "bun:test";

const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-lock-tests-"));
const testDir = path.dirname(fileURLToPath(import.meta.url));

afterAll(() => {
  fs.rmSync(hubDir, { recursive: true, force: true });
});

describe("lock state", () => {
  test("keeps the hub locked when unlock audit cannot be written", () => {
    const child = spawnSync(process.execPath, ["-e", `
      const fs = require("fs");
      const cfg = require("./config.ts");
      cfg.ensureDirs();
      fs.writeFileSync(cfg.LOCK_FILE, JSON.stringify({
        locked: true,
        at: new Date().toISOString(),
        by: "test",
      }));
      fs.mkdirSync(cfg.AUDIT_FILE);
      cfg.loadLockState();
      let threw = false;
      try {
        cfg.setUnlocked();
      } catch (err) {
        threw = String(err).includes("audit 不可写，拒绝 unlock");
      }
      console.log(JSON.stringify({
        threw,
        locked: cfg.getLockState().locked,
        lockFile: fs.existsSync(cfg.LOCK_FILE),
      }));
    `], {
      cwd: testDir,
      env: { ...process.env, FORGE_HUB_DIR: hubDir },
      encoding: "utf-8",
    });

    expect(child.status).toBe(0);
    const lastLine = child.stdout.trim().split("\n").at(-1) ?? "{}";
    expect(JSON.parse(lastLine)).toEqual({
      threw: true,
      locked: true,
      lockFile: true,
    });
  });
});
