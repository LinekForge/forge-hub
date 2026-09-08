import { describe, expect, test } from "bun:test";

import { chooseHubStarter } from "./hub-starter.js";

describe("chooseHubStarter", () => {
  test("delegates to launchd on macOS when the plist is installed", () => {
    expect(chooseHubStarter({ platform: "darwin", plistExists: true })).toBe("launchd");
  });

  test("spawns directly on macOS when no plist is installed", () => {
    expect(chooseHubStarter({ platform: "darwin", plistExists: false })).toBe("spawn");
  });

  test("spawns directly on linux even if a plist file happens to be present", () => {
    // launchd 是 macOS 专有，别的平台上这个文件没有意义
    expect(chooseHubStarter({ platform: "linux", plistExists: true })).toBe("spawn");
  });

  test("spawns directly on linux without a plist", () => {
    expect(chooseHubStarter({ platform: "linux", plistExists: false })).toBe("spawn");
  });
});
