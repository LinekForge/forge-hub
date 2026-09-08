/**
 * Hub 启动权归属。
 *
 * macOS 上装了 com.forge-hub.plist 时，hub 应该由 launchd 启动。hub-client 若自己
 * `spawn(..., { detached: true })` 再 `unref()`，会造出一个 launchd 管不到的孤儿：
 * 它占着 Hub 端口，launchd 每 ThrottleInterval 撞一次、崩一次，而 `cli.ts sync` 的
 * `launchctl bootout` 同样杀不到它（不是 launchd 的子进程）——于是 sync 的"重启"
 * 静默失效：磁盘上换成了新代码，跑着的还是旧进程。
 *
 * 没装 plist（或非 macOS）时，自己 spawn 仍然是唯一可行的启动方式，保持原行为。
 */
import path from "node:path";

export const LAUNCHD_LABEL = "com.forge-hub";

export function launchdPlistPath(home: string): string {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

export function chooseHubStarter(params: {
  platform: string;
  plistExists: boolean;
}): "launchd" | "spawn" {
  return params.platform === "darwin" && params.plistExists ? "launchd" : "spawn";
}
