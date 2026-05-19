import { describe, expect, test } from "bun:test";
import { execFileText, spawnText } from "./process-utils.js";

// ── execFileText ────────────────────────────────────────────────────────────

describe("execFileText", () => {
  test("captures stdout from echo", async () => {
    const result = await execFileText("echo", ["hello"]);
    expect(result).toBe("hello\n");
  });

  test("captures multi-word echo", async () => {
    const result = await execFileText("echo", ["hello", "world"]);
    expect(result).toBe("hello world\n");
  });

  test("returns empty string for empty echo", async () => {
    const result = await execFileText("echo", ["-n", ""]);
    expect(result).toBe("");
  });

  test("respects cwd option", async () => {
    const result = await execFileText("pwd", [], { cwd: "/tmp" });
    expect(["/tmp", "/private/tmp"]).toContain(result.trim());
  });

  test("respects env option", async () => {
    const result = await execFileText("env", [], {
      env: { ...process.env, TEST_FORGE_VAR: "forge_value" },
    });
    expect(result).toContain("TEST_FORGE_VAR=forge_value");
  });

  test("rejects on non-zero exit code", async () => {
    await expect(execFileText("false", [])).rejects.toThrow();
  });

  test("rejects on command not found", async () => {
    await expect(
      execFileText("__nonexistent_command_12345__", []),
    ).rejects.toThrow();
  });
});

// ── spawnText ───────────────────────────────────────────────────────────────

describe("spawnText", () => {
  test("captures stdout from echo", async () => {
    const { stdout } = await spawnText("echo", ["hello"]);
    expect(stdout).toBe("hello\n");
  });

  test("returns empty stderr on success", async () => {
    const { stderr } = await spawnText("echo", ["hello"]);
    expect(stderr).toBe("");
  });

  test("captures stderr", async () => {
    // sh -c writes to stderr via >&2
    const { stderr } = await spawnText("sh", ["-c", "echo oops >&2"]);
    expect(stderr).toBe("oops\n");
  });

  test("pipes input via stdin", async () => {
    const { stdout } = await spawnText("cat", [], { input: "from stdin" });
    expect(stdout).toBe("from stdin");
  });

  test("respects cwd option", async () => {
    const { stdout } = await spawnText("pwd", [], { cwd: "/tmp" });
    expect(["/tmp", "/private/tmp"]).toContain(stdout.trim());
  });

  test("respects env option", async () => {
    const { stdout } = await spawnText("sh", ["-c", "echo $MY_VAR"], {
      env: { ...process.env, MY_VAR: "hello_forge" },
    });
    expect(stdout.trim()).toBe("hello_forge");
  });

  test("rejects on non-zero exit code", async () => {
    await expect(spawnText("false", [])).rejects.toThrow();
  });

  test("rejects with stderr content as error message", async () => {
    try {
      await spawnText("sh", ["-c", "echo bad >&2; exit 1"]);
      throw new Error("should have rejected");
    } catch (err: unknown) {
      expect((err as Error).message).toBe("bad");
    }
  });

  test("rejects on command not found", async () => {
    await expect(
      spawnText("__nonexistent_command_12345__", []),
    ).rejects.toThrow();
  });

  test("rejects on timeout", async () => {
    await expect(
      spawnText("sleep", ["10"], { timeoutMs: 100 }),
    ).rejects.toThrow(/timeout/i);
  });

  test("multi-line stdout is captured fully", async () => {
    const { stdout } = await spawnText("sh", [
      "-c",
      "echo line1; echo line2; echo line3",
    ]);
    expect(stdout).toBe("line1\nline2\nline3\n");
  });
});
