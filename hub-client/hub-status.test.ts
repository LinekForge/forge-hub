import { describe, expect, test } from "bun:test";
import {
  classifyProtectedStatus,
  classifyPublicHealthStatus,
  HUB_AUTH_FAILURE_MESSAGE,
  isHubReachable,
} from "./hub-status.js";

describe("hub status probing helpers", () => {
  test("/health success means Hub is reachable", () => {
    const result = classifyPublicHealthStatus(200);
    expect(result.kind).toBe("ok");
    expect(isHubReachable(result)).toBe(true);
  });

  test("/status 401 is an auth failure, not an unreachable Hub", () => {
    const result = classifyProtectedStatus(401);
    expect(result.kind).toBe("unauthorized");
    expect(isHubReachable(result)).toBe(true);
    expect(HUB_AUTH_FAILURE_MESSAGE).toContain("认证失败");
    expect(HUB_AUTH_FAILURE_MESSAGE).toContain("token");
  });

  test("/health non-2xx is unreachable and may auto-start", () => {
    const result = classifyPublicHealthStatus(503);
    expect(result.kind).toBe("unreachable");
    expect(isHubReachable(result)).toBe(false);
  });
});
