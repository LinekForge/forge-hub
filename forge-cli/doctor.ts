export type HubStatusParseResult =
  | { kind: "online"; version: string; uptime: number }
  | { kind: "unauthorized" }
  | { kind: "invalid"; reason: string };

export type PublicHealthParseResult =
  | { kind: "online"; version: string; uptime: number }
  | { kind: "invalid"; reason: string };

export function splitCurlBodyAndStatus(raw: string): { body: string; status: number } {
  const trimmed = raw.replace(/\s+$/, "");
  const idx = trimmed.lastIndexOf("\n");
  if (idx < 0) return { body: "", status: Number(trimmed) || 0 };
  const status = Number(trimmed.slice(idx + 1));
  return {
    body: trimmed.slice(0, idx),
    status: Number.isFinite(status) ? status : 0,
  };
}

export function parsePublicHealthResponse(status: number, body: string): PublicHealthParseResult {
  if (status !== 200) {
    return { kind: "invalid", reason: `HTTP ${status}` };
  }
  try {
    const data = JSON.parse(body) as { version?: unknown; uptime?: unknown };
    if (typeof data.version === "string" && typeof data.uptime === "number") {
      return { kind: "online", version: data.version, uptime: data.uptime };
    }
    return { kind: "invalid", reason: "missing version/uptime in /health response" };
  } catch (err) {
    return { kind: "invalid", reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function parseHubStatusResponse(status: number, body: string): HubStatusParseResult {
  if (status === 401) return { kind: "unauthorized" };
  if (status !== 200) return { kind: "invalid", reason: `HTTP ${status}` };

  try {
    const data = JSON.parse(body) as {
      error?: unknown;
      version?: unknown;
      uptime?: unknown;
      hub?: { version?: unknown; uptime?: unknown };
    };

    if (data.error === "unauthorized") return { kind: "unauthorized" };

    const version = data.hub?.version ?? data.version;
    const uptime = data.hub?.uptime ?? data.uptime;
    if (typeof version === "string" && typeof uptime === "number") {
      return { kind: "online", version, uptime };
    }

    return { kind: "invalid", reason: "missing hub.version/hub.uptime in /status response" };
  } catch (err) {
    return { kind: "invalid", reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}
