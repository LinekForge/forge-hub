export type HubProbeResult =
  | { kind: "ok"; status?: number }
  | { kind: "unauthorized"; status: 401 }
  | { kind: "unreachable"; status?: number; reason: string };

export const HUB_AUTH_FAILURE_MESSAGE =
  "Hub 在线但认证失败，请检查 token 配置（HUB_API_TOKEN 或 ~/.forge-hub/api-token）";

export function classifyPublicHealthStatus(status: number): HubProbeResult {
  if (status >= 200 && status < 300) return { kind: "ok", status };
  return { kind: "unreachable", status, reason: `/health HTTP ${status}` };
}

export function classifyProtectedStatus(status: number): HubProbeResult {
  if (status === 401) return { kind: "unauthorized", status };
  if (status >= 200 && status < 300) return { kind: "ok", status };
  return { kind: "unreachable", status, reason: `/status HTTP ${status}` };
}

export function isHubReachable(result: HubProbeResult): boolean {
  return result.kind === "ok" || result.kind === "unauthorized";
}
