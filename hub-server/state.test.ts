import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findAllowlistEntry,
  getNickname,
  isAllowedSender,
  loadAllowlist,
  loadChannelState,
  readAllowlist,
  saveChannelState,
} from "./state.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-state-tests-"));
  process.env.FORGE_HUB_DIR = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.FORGE_HUB_DIR;
});

// ── loadChannelState / saveChannelState ─────────────────────────────────────

describe("loadChannelState", () => {
  test("returns null for a missing key", () => {
    expect(loadChannelState("test-ch", "nonexistent")).toBeNull();
  });

  test("round-trips a JSON value through save then load", () => {
    const data = { count: 42, tags: ["a", "b"] };
    saveChannelState("test-ch", "config", data);
    expect(loadChannelState("test-ch", "config")).toEqual(data);
  });

  test("creates the channel directory if it does not exist", () => {
    saveChannelState("new-ch", "key", { ok: true });
    const dir = path.join(tmpDir, "state", "new-ch");
    expect(fs.existsSync(dir)).toBe(true);
  });

  test("writes valid JSON to disk", () => {
    saveChannelState("test-ch", "data", { hello: "world" });
    const filePath = path.join(tmpDir, "state", "test-ch", "data.json");
    const raw = fs.readFileSync(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ hello: "world" });
  });

  test("overwrites existing state", () => {
    saveChannelState("test-ch", "counter", { v: 1 });
    saveChannelState("test-ch", "counter", { v: 2 });
    expect(loadChannelState("test-ch", "counter")).toEqual({ v: 2 });
  });

  test("handles different channels independently", () => {
    saveChannelState("ch-a", "key", { from: "a" });
    saveChannelState("ch-b", "key", { from: "b" });
    expect(loadChannelState("ch-a", "key")).toEqual({ from: "a" });
    expect(loadChannelState("ch-b", "key")).toEqual({ from: "b" });
  });

  test("returns a clone — mutating the result does not affect stored state", () => {
    saveChannelState("test-ch", "obj", { items: [1, 2, 3] });
    const first = loadChannelState("test-ch", "obj") as { items: number[] };
    first.items.push(4);
    const second = loadChannelState("test-ch", "obj") as { items: number[] };
    expect(second.items).toEqual([1, 2, 3]);
  });

  test("returns null for corrupt JSON on disk", () => {
    const dir = path.join(tmpDir, "state", "test-ch");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), "not json {{{");
    expect(loadChannelState("test-ch", "broken")).toBeNull();
  });
});

// ── loadAllowlist / readAllowlist ───────────────────────────────────────────

describe("loadAllowlist", () => {
  test("returns default allowlist when no file exists", () => {
    const al = loadAllowlist("no-such-ch");
    expect(al).toEqual({ allowed: [], auto_allow_next: false });
  });

  test("loads a valid allowlist from disk", () => {
    const data = {
      allowed: [{ id: "user-1", nickname: "Alice" }],
      auto_allow_next: true,
    };
    saveChannelState("wechat", "allowlist", data);
    const al = loadAllowlist("wechat");
    expect(al.allowed).toHaveLength(1);
    expect(al.allowed[0].id).toBe("user-1");
    expect(al.auto_allow_next).toBe(true);
  });

  test("returns default when allowlist file is corrupt", () => {
    const dir = path.join(tmpDir, "state", "test-ch");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "allowlist.json"), "INVALID");
    const al = loadAllowlist("test-ch");
    expect(al).toEqual({ allowed: [], auto_allow_next: false });
  });
});

describe("readAllowlist", () => {
  test("returns ok with allowlist data when file exists", () => {
    const data = {
      allowed: [{ id: "u1", nickname: "Bob" }],
      auto_allow_next: false,
    };
    saveChannelState("telegram", "allowlist", data);
    const result = readAllowlist("telegram");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.allowlist.allowed).toHaveLength(1);
      expect(result.allowlist.allowed[0].nickname).toBe("Bob");
    }
  });

  test("returns error when allowlist file is missing", () => {
    const result = readAllowlist("nonexistent-ch");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("allowlist not found");
    }
  });

  test("returns error when allowlist file is corrupt JSON", () => {
    const dir = path.join(tmpDir, "state", "bad-ch");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "allowlist.json"), "{{{bad");
    const result = readAllowlist("bad-ch");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });
});

// ── isAllowedSender ─────────────────────────────────────────────────────────

describe("isAllowedSender", () => {
  test("returns false when allowlist is empty", () => {
    expect(isAllowedSender("test-ch", "anyone")).toBe(false);
  });

  test("returns true for an allowed sender", () => {
    saveChannelState("telegram", "allowlist", {
      allowed: [{ id: "12345", nickname: "User" }],
      auto_allow_next: false,
    });
    expect(isAllowedSender("telegram", "12345")).toBe(true);
  });

  test("returns false for an unlisted sender", () => {
    saveChannelState("telegram", "allowlist", {
      allowed: [{ id: "12345", nickname: "User" }],
      auto_allow_next: false,
    });
    expect(isAllowedSender("telegram", "99999")).toBe(false);
  });

  test("matches case-insensitively for imessage", () => {
    saveChannelState("imessage", "allowlist", {
      allowed: [{ id: "user@icloud.com", nickname: "Me" }],
      auto_allow_next: false,
    });
    expect(isAllowedSender("imessage", "User@iCloud.COM")).toBe(true);
  });

  test("matches case-sensitively for non-imessage channels", () => {
    saveChannelState("wechat", "allowlist", {
      allowed: [{ id: "Abc@im.wechat", nickname: "W" }],
      auto_allow_next: false,
    });
    expect(isAllowedSender("wechat", "abc@im.wechat")).toBe(false);
    expect(isAllowedSender("wechat", "Abc@im.wechat")).toBe(true);
  });

  test("matches any entry in a multi-entry allowlist", () => {
    saveChannelState("telegram", "allowlist", {
      allowed: [
        { id: "111", nickname: "A" },
        { id: "222", nickname: "B" },
        { id: "333", nickname: "C" },
      ],
      auto_allow_next: false,
    });
    expect(isAllowedSender("telegram", "222")).toBe(true);
    expect(isAllowedSender("telegram", "444")).toBe(false);
  });
});

// ── getNickname ─────────────────────────────────────────────────────────────

describe("getNickname", () => {
  test("returns the nickname for a known sender", () => {
    saveChannelState("telegram", "allowlist", {
      allowed: [{ id: "12345", nickname: "Alice" }],
      auto_allow_next: false,
    });
    expect(getNickname("telegram", "12345")).toBe("Alice");
  });

  test("falls back to senderId when not in allowlist", () => {
    saveChannelState("telegram", "allowlist", {
      allowed: [{ id: "12345", nickname: "Alice" }],
      auto_allow_next: false,
    });
    expect(getNickname("telegram", "99999")).toBe("99999");
  });

  test("falls back to senderId when no allowlist exists", () => {
    expect(getNickname("no-ch", "some-id")).toBe("some-id");
  });

  test("resolves imessage nickname case-insensitively", () => {
    saveChannelState("imessage", "allowlist", {
      allowed: [{ id: "me@icloud.com", nickname: "Me" }],
      auto_allow_next: false,
    });
    expect(getNickname("imessage", "ME@ICLOUD.COM")).toBe("Me");
  });
});

// ── findAllowlistEntry ──────────────────────────────────────────────────────

describe("findAllowlistEntry", () => {
  test("returns the matching entry", () => {
    saveChannelState("telegram", "allowlist", {
      allowed: [
        { id: "aaa", nickname: "First" },
        { id: "bbb", nickname: "Second" },
      ],
      auto_allow_next: false,
    });
    const entry = findAllowlistEntry("telegram", "bbb");
    expect(entry).toEqual({ id: "bbb", nickname: "Second" });
  });

  test("returns undefined for no match", () => {
    saveChannelState("telegram", "allowlist", {
      allowed: [{ id: "aaa", nickname: "First" }],
      auto_allow_next: false,
    });
    expect(findAllowlistEntry("telegram", "zzz")).toBeUndefined();
  });

  test("returns undefined when no allowlist exists", () => {
    expect(findAllowlistEntry("ghost", "id")).toBeUndefined();
  });
});
