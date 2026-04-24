import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const HUB_SERVER_PATH = path.join(import.meta.dir, "hub.ts");
const EVIL_ORIGIN = "https://evil.example";

interface TestHub {
  child: ChildProcess;
  tmpDir: string;
  url: string;
  token?: string;
}

const hubs: TestHub[] = [];

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

async function startHub(token?: string): Promise<TestHub> {
  const port = await getFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-origin-"));
  const channelsDir = path.join(tmpDir, "channels");
  fs.mkdirSync(channelsDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "hub-config.json"),
    JSON.stringify({
      port,
      host: "127.0.0.1",
      primary_instance: "",
      show_instance_tag: false,
      auto_replay_on_ready: false,
    }),
  );

  const child = spawn("bun", [HUB_SERVER_PATH], {
    env: {
      ...process.env,
      FORGE_HUB_DIR: tmpDir,
      FORGE_HUB_CHANNELS_DIR: channelsDir,
      ...(token ? { HUB_API_TOKEN: token } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  const hub = { child, tmpDir, url: `http://127.0.0.1:${port}`, token };
  hubs.push(hub);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${hub.url}/health`);
      if (res.ok) return hub;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`test Hub did not start on ${hub.url}`);
}

async function stopHub(hub: TestHub): Promise<void> {
  if (!hub.child.killed) {
    hub.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!hub.child.killed) {
      try { hub.child.kill("SIGKILL"); } catch {}
    }
  }
  fs.rmSync(hub.tmpDir, { recursive: true, force: true });
}

afterEach(async () => {
  while (hubs.length > 0) {
    const hub = hubs.pop()!;
    await stopHub(hub);
  }
});

async function expectForbiddenFromEvilOrigin(hub: TestHub, pathname: string, init: RequestInit = {}): Promise<void> {
  const headers = new Headers(init.headers);
  headers.set("Origin", EVIL_ORIGIN);
  if (hub.token) headers.set("Authorization", `Bearer ${hub.token}`);
  const res = await fetch(`${hub.url}${pathname}`, { ...init, headers });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "forbidden_origin" });
}

describe("browser Origin guard", () => {
  test("rejects malicious browser origins in no-token mode", async () => {
    const hub = await startHub();

    await expectForbiddenFromEvilOrigin(hub, "/ws?instance=evil");
    await expectForbiddenFromEvilOrigin(hub, "/homeland/stream");
    await expectForbiddenFromEvilOrigin(hub, "/pending/not-there/approve", { method: "POST" });
    await expectForbiddenFromEvilOrigin(hub, "/lock", { method: "POST" });
  });

  test("rejects malicious browser origins in token mode even with a valid token", async () => {
    const hub = await startHub("test-token");

    await expectForbiddenFromEvilOrigin(hub, "/ws?instance=evil");
    await expectForbiddenFromEvilOrigin(hub, "/homeland/stream");
    await expectForbiddenFromEvilOrigin(hub, "/pending/not-there/deny", { method: "POST" });
    await expectForbiddenFromEvilOrigin(hub, "/unlock", { method: "POST" });
  });

  test("keeps no-Origin localhost calls available for CLI/curl compatibility", async () => {
    const hub = await startHub();

    const res = await fetch(`${hub.url}/lock`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, locked: true });
  });

  test("echoes trusted dashboard origin for Homeland SSE", async () => {
    const hub = await startHub();
    const origin = `http://localhost:${new URL(hub.url).port}`;

    const res = await fetch(`${hub.url}/homeland/stream`, {
      headers: { Origin: origin },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(res.headers.get("Vary")).toBe("Origin");
    await res.body?.cancel();
  });
});
