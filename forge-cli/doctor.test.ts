import { describe, expect, test } from "bun:test";

import {
  parseHubStatusResponse,
  parsePublicHealthResponse,
  splitCurlBodyAndStatus,
} from "./doctor.js";

describe("doctor response helpers", () => {
  test("splits curl body from trailing HTTP status", () => {
    expect(splitCurlBodyAndStatus('{"ok":true}\n200')).toEqual({
      body: '{"ok":true}',
      status: 200,
    });
  });

  test("parses public /health liveness response", () => {
    expect(parsePublicHealthResponse(200, '{"version":"0.2.0","uptime":90}')).toEqual({
      kind: "online",
      version: "0.2.0",
      uptime: 90,
    });
  });

  test("parses current /status schema with hub envelope", () => {
    expect(parseHubStatusResponse(200, '{"hub":{"version":"0.2.0","uptime":120}}')).toEqual({
      kind: "online",
      version: "0.2.0",
      uptime: 120,
    });
  });

  test("keeps compatibility with legacy top-level /status schema", () => {
    expect(parseHubStatusResponse(200, '{"version":"0.1.0","uptime":60}')).toEqual({
      kind: "online",
      version: "0.1.0",
      uptime: 60,
    });
  });

  test("treats token-protected /status as online but unauthorized", () => {
    expect(parseHubStatusResponse(401, '{"error":"unauthorized"}')).toEqual({
      kind: "unauthorized",
    });
    expect(parseHubStatusResponse(200, '{"error":"unauthorized"}')).toEqual({
      kind: "unauthorized",
    });
  });

  test("does not turn malformed /status into a fake success", () => {
    expect(parseHubStatusResponse(200, '{"error":"something else"}')).toMatchObject({
      kind: "invalid",
    });
  });
});
