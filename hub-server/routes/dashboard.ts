import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DASHBOARD_AUTH_COOKIE = "forge_hub_dashboard";
const DASHBOARD_DIR_CANDIDATES = [
  process.env.FORGE_HUB_DASHBOARD_DIR,
  path.join(import.meta.dir, "..", "hub-dashboard", "dist"),
  path.join(import.meta.dir, "..", "..", "hub-dashboard", "dist"),
].filter((entry): entry is string => Boolean(entry));

const DASHBOARD_MIME_TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "application/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".woff2": "font/woff2", ".woff": "font/woff",
};

function dashboardAuthDigest(apiToken: string): string {
  return crypto.createHash("sha256").update(`forge-hub-dashboard:${apiToken}`).digest("hex");
}

export function hasDashboardSession(req: Request, apiToken: string): boolean {
  if (!apiToken) return false;
  const raw = req.headers.get("Cookie") ?? "";
  const parsed: Record<string, string> = {};
  for (const chunk of raw.split(";")) {
    const [name, ...rest] = chunk.trim().split("=");
    if (!name) continue;
    parsed[name] = decodeURIComponent(rest.join("="));
  }
  return parsed[DASHBOARD_AUTH_COOKIE] === dashboardAuthDigest(apiToken);
}

export function trustedDashboardOrigins(url: URL): Set<string> {
  const origins = new Set<string>();
  const port = url.port ? `:${url.port}` : "";
  origins.add(`${url.protocol}//localhost${port}`);
  origins.add(`${url.protocol}//127.0.0.1${port}`);
  origins.add(`${url.protocol}//[::1]${port}`);
  const configured = process.env.FORGE_HUB_DASHBOARD_ORIGINS ?? "";
  for (const origin of configured.split(",").map((entry) => entry.trim()).filter(Boolean)) {
    origins.add(origin);
  }
  return origins;
}

export function trustedDashboardCorsHeaders(req: Request, url: URL): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin || !trustedDashboardOrigins(url).has(origin)) return {};
  return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
}

export function shouldRejectUntrustedBrowserOrigin(req: Request, url: URL, routePath: string, isWsUpgrade: boolean): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return false;
  const requiresCheck = isWsUpgrade ||
    (req.method === "GET" && routePath === "/homeland/stream") ||
    ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
  if (!requiresCheck) return false;
  return !trustedDashboardOrigins(url).has(origin);
}

function resolveDashboardDir(): string | null {
  for (const candidate of DASHBOARD_DIR_CANDIDATES) {
    const root = path.resolve(candidate);
    try { if (fs.existsSync(path.join(root, "index.html"))) return root; } catch { /* best-effort */ }
  }
  return null;
}

function resolveDashboardStaticFile(pathname: string): string | null {
  const dashboardDir = resolveDashboardDir();
  if (!dashboardDir) return null;
  const rawRelative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const normalizedRelative = path.posix.normalize(rawRelative);
  if (!normalizedRelative || normalizedRelative.startsWith("..")) return null;
  const filePath = path.resolve(dashboardDir, normalizedRelative);
  const dashboardRoot = path.resolve(dashboardDir);
  if (!filePath.startsWith(dashboardRoot + path.sep) && filePath !== dashboardRoot) return null;
  try { if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return filePath; } catch { /* best-effort */ }
  return null;
}

export function isDashboardStaticRequest(req: Request, url: URL): boolean {
  return req.method === "GET" && resolveDashboardStaticFile(url.pathname) !== null;
}

export function serveDashboardStaticOrSpa(url: URL): Response | null {
  const exactFile = resolveDashboardStaticFile(url.pathname);
  if (exactFile) {
    const ext = path.extname(exactFile).toLowerCase();
    return new Response(Bun.file(exactFile), {
      headers: { "Content-Type": DASHBOARD_MIME_TYPES[ext] ?? "application/octet-stream" },
    });
  }
  const wantsSpaShell = !path.extname(url.pathname) && !url.pathname.startsWith("/api/");
  if (wantsSpaShell) {
    const indexFile = resolveDashboardStaticFile("/");
    if (indexFile) {
      return new Response(Bun.file(indexFile), {
        headers: { "Content-Type": "text/html" },
      });
    }
  }
  return null;
}

export async function handleDashboardAuth(req: Request, apiToken: string): Promise<Response> {
  if (!apiToken) {
    return Response.json(
      { success: true, auth_required: false },
      { headers: { "Set-Cookie": `${DASHBOARD_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } },
    );
  }
  const body = await req.json() as { token?: string };
  if (!body.token) return Response.json({ success: false, error: "缺少 token" }, { status: 400 });
  if (body.token !== apiToken) return Response.json({ success: false, error: "token 不正确" }, { status: 401 });
  return Response.json(
    { success: true, auth_required: false },
    { headers: { "Set-Cookie": `${DASHBOARD_AUTH_COOKIE}=${dashboardAuthDigest(apiToken)}; Path=/; HttpOnly; SameSite=Strict` } },
  );
}

export function handleDashboardLogout(): Response {
  return Response.json(
    { success: true },
    { headers: { "Set-Cookie": `${DASHBOARD_AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` } },
  );
}
