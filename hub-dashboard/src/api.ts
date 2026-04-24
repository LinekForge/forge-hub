import type { HistoryItem, OverviewData } from "./types";

const BASE = (() => {
  if (typeof window === "undefined") return "/api";
  if (window.location.protocol === "file:") return "http://localhost:9900";
  if (window.location.port === "9900") return "";
  return "/api";
})();
export const HUB_AUTH_EVENT = "hub-auth-state";
let dashboardBearerToken = "";

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

export function setDashboardBearerToken(token: string): void {
  dashboardBearerToken = token.trim();
}

export function getDashboardBearerToken(): string {
  return dashboardBearerToken;
}

function credentialsMode(): RequestCredentials {
  return BASE.startsWith("http") ? "include" : "same-origin";
}

function authHeaders(headers: Record<string, string> = {}): Record<string, string> {
  if (!dashboardBearerToken) return headers;
  return { ...headers, Authorization: `Bearer ${dashboardBearerToken}` };
}

function emitAuthState(required: boolean, message?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(HUB_AUTH_EVENT, {
    detail: { required, message },
  }));
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(apiUrl(path), {
      credentials: credentialsMode(),
      headers: authHeaders(),
    });
    if (res.status === 401) {
      emitAuthState(true);
      return null;
    }
    if (!res.ok) return null;
    emitAuthState(false);
    return await res.json();
  } catch {
    return null;
  }
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(apiUrl(path), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      credentials: credentialsMode(),
      body: JSON.stringify(body),
    });
    if (res.status === 401) {
      emitAuthState(true);
      return null;
    }
    if (!res.ok) return null;
    emitAuthState(false);
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchOverview(): Promise<OverviewData | null> {
  return get("/overview");
}

export async function fetchHistory(channel: string, limit = 50): Promise<HistoryItem[] | null> {
  const params = new URLSearchParams({ channel, limit: String(limit) });
  const data = await get<{ history?: HistoryItem[] }>(`/history?${params.toString()}`);
  return data?.history ?? null;
}

export async function fetchHealthFallback(): Promise<OverviewData | null> {
  try {
    const [healthRes, pendingRes] = await Promise.all([
      fetch(apiUrl("/status"), {
        credentials: credentialsMode(),
        headers: authHeaders(),
      }),
      fetch(apiUrl("/pending"), {
        credentials: credentialsMode(),
        headers: authHeaders(),
      }),
    ]);
    if (healthRes.status === 401 || pendingRes.status === 401) {
      emitAuthState(true);
      return null;
    }
    if (!healthRes.ok) return null;
    emitAuthState(false);
    const health = await healthRes.json();
    const pendingData = pendingRes.ok ? await pendingRes.json() : { pending: [] };
    return {
      instances: health.instances ?? [],
      channels: health.channels ?? {},
      pending: pendingData.pending ?? [],
      hub: health.hub ? {
        version: health.hub.version ?? "?",
        uptime: health.hub.uptime ?? 0,
        memory_mb: health.hub.memory_mb ?? 0,
        pid: health.hub.pid,
        started_at: health.hub.started_at ?? "",
        locked: health.hub.lock?.locked ?? health.hub.locked ?? false,
      } : { version: "?", uptime: 0, memory_mb: 0, pid: undefined, started_at: "", locked: false },
    };
  } catch {
    return null;
  }
}

export async function sendMessage(content: string, channels?: string[], instance?: string): Promise<boolean> {
  if (channels?.length) {
    const data = await post<{ any_ok: boolean }>("/send", { channels, content, to: "local://operator" });
    return data?.any_ok ?? false;
  }
  const data = await post<{ success: boolean }>("/homeland/send", { content, instance });
  return data?.success ?? false;
}

export async function approveFromDashboard(requestId: string): Promise<boolean> {
  const data = await post<{ success: boolean }>(`/pending/${requestId}/approve`, {});
  return data?.success ?? false;
}

export async function denyFromDashboard(requestId: string): Promise<boolean> {
  const data = await post<{ success: boolean }>(`/pending/${requestId}/deny`, {});
  return data?.success ?? false;
}

export async function dismissFromDashboard(requestId: string): Promise<boolean> {
  const data = await post<{ success: boolean }>(`/pending/${requestId}/dismiss`, {});
  return data?.success ?? false;
}

export async function reportPresence(active: boolean): Promise<void> {
  await post("/homeland/presence", { active });
}

export async function authenticateDashboard(token: string): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await fetch(apiUrl("/dashboard-auth"), {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      credentials: credentialsMode(),
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      emitAuthState(false);
      return { success: true };
    }
    const data = await res.json().catch(() => ({}));
    const error = typeof data.error === "string" ? data.error : "认证失败";
    emitAuthState(true, error);
    return { success: false, error };
  } catch {
    const error = "认证请求失败";
    emitAuthState(true, error);
    return { success: false, error };
  }
}
