import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readRecentHistoryFile } from "./history.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

async function makeHistoryFile(lines: string[]): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "forge-hub-history-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "chat-history.jsonl");
  await fs.promises.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

describe("history tail reader", () => {
  test("returns the newest valid entries in chronological order", async () => {
    const filePath = await makeHistoryFile([
      JSON.stringify({ ts: "2026-04-22T10:00:00.000Z", text: "first" }),
      "{not-json",
      JSON.stringify({ ts: "2026-04-22T10:02:00.000Z", text: "second" }),
      JSON.stringify({ ts: "2026-04-22T10:03:00.000Z", text: "third" }),
    ]);

    const entries = await readRecentHistoryFile(filePath, 2);

    expect(entries.map((entry) => entry.text)).toEqual(["second", "third"]);
  });

  test("applies since_ts before taking the newest limit", async () => {
    const filePath = await makeHistoryFile([
      JSON.stringify({ ts: "2026-04-22T10:00:00.000Z", text: "first" }),
      JSON.stringify({ ts: "2026-04-22T10:01:00.000Z", text: "second" }),
      JSON.stringify({ ts: "2026-04-22T10:02:00.000Z", text: "third" }),
      JSON.stringify({ ts: "2026-04-22T10:03:00.000Z", text: "fourth" }),
      JSON.stringify({ ts: "2026-04-22T10:04:00.000Z", text: "fifth" }),
    ]);

    const entries = await readRecentHistoryFile(filePath, 2, "2026-04-22T10:01:30.000Z");

    expect(entries.map((entry) => entry.text)).toEqual(["fourth", "fifth"]);
  });
});
