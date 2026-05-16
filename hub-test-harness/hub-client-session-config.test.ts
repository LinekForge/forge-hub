import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getSessionConfigPaths,
  isChannelMode,
  readAndClearSessionConfig,
} from "../hub-client/session-config.js";

const tempDirs: string[] = [];

function mkHubDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-client-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("hub client session config", () => {
  test("returns null when no launcher state exists so callers can auto-detect mode", () => {
    const hubDir = mkHubDir();
    const config = readAndClearSessionConfig(getSessionConfigPaths(hubDir), "forge-123", () => {});

    expect(config).toBeNull();
    expect(isChannelMode(config)).toBe(false);
  });

  test("treats explicit next-session without channels as tool mode", () => {
    const hubDir = mkHubDir();
    const paths = getSessionConfigPaths(hubDir);
    fs.mkdirSync(hubDir, { recursive: true });
    fs.writeFileSync(paths.sessionFile, JSON.stringify({ description: "Tool session" }), "utf-8");

    const config = readAndClearSessionConfig(paths, "forge-123", () => {});

    expect(config?.description).toBe("Tool session");
    expect(isChannelMode(config)).toBe(false);
    expect(fs.existsSync(paths.sessionFile)).toBe(false);
  });

  test("keeps legacy 'all' sessions in channel mode", () => {
    const hubDir = mkHubDir();
    const paths = getSessionConfigPaths(hubDir);
    fs.mkdirSync(hubDir, { recursive: true });
    fs.writeFileSync(paths.legacyNameFile, "ops,Ops session,all", "utf-8");

    const config = readAndClearSessionConfig(paths, "forge-123", () => {});

    expect(config?.tag).toBe("ops");
    expect(config?.channels).toBeUndefined();
    expect(isChannelMode(config)).toBe(true);
    expect(fs.existsSync(paths.legacyNameFile)).toBe(false);
  });

  test("crash recovery restores tag/description but NOT isChannel from identities", () => {
    const hubDir = mkHubDir();
    const paths = getSessionConfigPaths(hubDir);
    fs.mkdirSync(path.dirname(paths.identitiesFile), { recursive: true });
    fs.writeFileSync(
      paths.identitiesFile,
      JSON.stringify({
        "forge-123": {
          description: "Recovered session",
          tag: "ops",
          isChannel: true,
        },
      }),
      "utf-8",
    );

    const config = readAndClearSessionConfig(paths, "forge-123", () => {});

    expect(config?.description).toBe("Recovered session");
    expect(config?.tag).toBe("ops");
    expect(isChannelMode(config)).toBe(false);
  });
});
