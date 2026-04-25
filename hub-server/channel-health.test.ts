import { describe, test, expect } from "bun:test";
import { ChannelHealth } from "./channel-health.js";

function makeHealth(overrides: Record<string, unknown> = {}) {
  const logs: string[] = [];
  let restartCount = 0;
  return {
    logs,
    getRestartCount: () => restartCount,
    health: new ChannelHealth({
      name: "test",
      baseRetryMs: 100,
      maxRetryMs: 500,
      dormantProbeMs: 1000,
      dormantCooldownMs: 500,
      onRestart: async () => { restartCount++; },
      log: (msg: string) => logs.push(msg),
      ...overrides,
    }),
  };
}

describe("ChannelHealth", () => {
  test("starts healthy", () => {
    const { health } = makeHealth();
    expect(health.getState()).toBe("healthy");
  });

  test("transitions to recovering on failure", async () => {
    const { health, logs } = makeHealth();
    await health.onFailure();
    expect(health.getState()).toBe("recovering");
    expect(logs.some(l => l.includes("HEALTHY → RECOVERING"))).toBe(true);
  });

  test("returns to healthy on success", async () => {
    const { health, logs } = makeHealth();
    await health.onFailure();
    health.onSuccess();
    expect(health.getState()).toBe("healthy");
    expect(logs.some(l => l.includes("→ HEALTHY"))).toBe(true);
  });

  test("retry delay increases", async () => {
    const { health } = makeHealth({ jitter: 0 });
    const d1 = await health.onFailure();
    const d2 = await health.onFailure();
    expect(d2).toBeGreaterThan(d1);
  });

  test("retry delay caps at maxRetryMs", async () => {
    const { health } = makeHealth({ jitter: 0 });
    for (let i = 0; i < 20; i++) await health.onFailure();
    const delay = await health.onFailure();
    expect(delay).toBeLessThanOrEqual(500);
  });

  test("success resets retry delay", async () => {
    const { health } = makeHealth({ jitter: 0 });
    for (let i = 0; i < 5; i++) await health.onFailure();
    health.onSuccess();
    const d = await health.onFailure();
    expect(d).toBe(100);
  });

  test("onOutboundRequest returns true when healthy", async () => {
    const { health } = makeHealth();
    expect(await health.onOutboundRequest()).toBe(true);
  });

  test("onOutboundRequest returns true when recovering", async () => {
    const { health } = makeHealth();
    await health.onFailure();
    expect(await health.onOutboundRequest()).toBe(true);
  });

  test("isDormant returns false when healthy", () => {
    const { health } = makeHealth();
    expect(health.isDormant()).toBe(false);
  });

  test("shouldContinue always returns true", async () => {
    const { health } = makeHealth();
    expect(health.shouldContinue()).toBe(true);
    await health.onFailure();
    expect(health.shouldContinue()).toBe(true);
  });

  test("state transitions log correctly", async () => {
    const { health, logs } = makeHealth();
    await health.onFailure();
    expect(logs.length).toBeGreaterThan(0);
    health.onSuccess();
    expect(logs.some(l => l.includes("HEALTHY"))).toBe(true);
  });
});
