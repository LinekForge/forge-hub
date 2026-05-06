/**
 * Forge Hub — Per-instance rate limit for /permission-request
 *
 * 每 instance 60 秒内最多 20 次 /permission-request，超限返 429。
 * 开源场景下可能有 rogue instance 疯狂发审批 spam 用户——这条兜底。
 * 正常用户一次审批 = 用户的 Forge 几秒内发 1 次，20/min 对真实使用完全不紧。
 * 本机 localhost-only 场景下攻击面小，但 config 可调让开源用户加强。
 */

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX = 20;
const permissionRequestRate = new Map<string, number[]>();

export function checkPermissionRate(instanceId: string): boolean {
  const now = Date.now();
  const window = permissionRequestRate.get(instanceId) ?? [];
  const fresh = window.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT_MAX) {
    permissionRequestRate.set(instanceId, fresh);
    return false;
  }
  fresh.push(now);
  permissionRequestRate.set(instanceId, fresh);
  return true;
}

export function pruneRateLimitMap(): void {
  const now = Date.now();
  for (const [id, timestamps] of permissionRequestRate) {
    if (timestamps.every((ts) => now - ts >= RATE_LIMIT_WINDOW_MS)) {
      permissionRequestRate.delete(id);
    }
  }
}
