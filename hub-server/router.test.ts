import { describe, expect, test } from "bun:test";

import { route } from "./router.js";
import type { ConnectedInstance, HubConfig, InboundMessage } from "./types.js";

function makeInstance(id: string, tag?: string): ConnectedInstance {
  return {
    id,
    tag,
    connectedAt: new Date().toISOString(),
    ws: {} as ConnectedInstance["ws"],
    send() { return 1; },
    close() {},
  };
}

const baseConfig: HubConfig = {
  port: 9900,
  host: "127.0.0.1",
  primary_instance: "",
  show_instance_tag: true,
};

function makeMessage(content: string): InboundMessage {
  return {
    channel: "wechat",
    from: "Operator",
    fromId: "wx_123",
    content,
    raw: {},
  };
}

describe("router", () => {
  test("routes standalone @mentions to the matched instance", () => {
    const instances = new Map<string, ConnectedInstance>([
      ["instance-1", makeInstance("instance-1", "ops")],
      ["instance-2", makeInstance("instance-2", "qa")],
    ]);

    const result = route(makeMessage("please @ops check this"), instances, baseConfig);

    expect(result).toEqual({
      targets: ["instance-1"],
      targeted: true,
      content: "please check this",
    });
  });

  test("ignores @ fragments inside emails and words", () => {
    const instances = new Map<string, ConnectedInstance>([
      ["instance-1", makeInstance("instance-1", "ops")],
    ]);

    const result = route(
      makeMessage("mail foo@ops.com and 请看@ops版本"),
      instances,
      baseConfig,
    );

    expect(result.targeted).toBe(false);
    expect(result.content).toBe("mail foo@ops.com and 请看@ops版本");
    expect(result.targets).toEqual(["instance-1"]);
  });

  test("deduplicates repeated mentions for the same instance", () => {
    const instances = new Map<string, ConnectedInstance>([
      ["instance-1", makeInstance("instance-1", "ops")],
      ["instance-2", makeInstance("instance-2", "qa")],
    ]);

    const result = route(
      makeMessage("@ops @instance-1 please check this"),
      instances,
      baseConfig,
    );

    expect(result.targets).toEqual(["instance-1"]);
    expect(result.targeted).toBe(true);
    expect(result.content).toBe("please check this");
  });

  test("prefers an explicit dashboard target instance over primary or broadcast routing", () => {
    const instances = new Map<string, ConnectedInstance>([
      ["instance-1", makeInstance("instance-1", "ops")],
      ["instance-2", makeInstance("instance-2", "qa")],
    ]);

    const result = route(
      {
        ...makeMessage("please handle this"),
        channel: "homeland",
        targetInstanceId: "instance-2",
      },
      instances,
      { ...baseConfig, primary_instance: "instance-1" },
    );

    expect(result).toEqual({
      targets: ["instance-2"],
      targeted: true,
      content: "please handle this",
    });
  });

  test("fails closed when an explicit @mention does not resolve", () => {
    const instances = new Map<string, ConnectedInstance>([
      ["instance-1", makeInstance("instance-1", "ops")],
      ["instance-2", makeInstance("instance-2", "qa")],
    ]);

    const result = route(makeMessage("please @offline check this"), instances, baseConfig);

    expect(result).toEqual({
      targets: [],
      targeted: true,
      content: "please check this",
      failure: {
        kind: "unresolved_mention",
        detail: "未找到实例 @offline",
      },
    });
  });

  test("fails closed when duplicate tags make @routing ambiguous", () => {
    const instances = new Map<string, ConnectedInstance>([
      ["instance-1", makeInstance("instance-1", "ops")],
      ["instance-2", makeInstance("instance-2", "ops")],
    ]);

    const result = route(makeMessage("please @ops check this"), instances, baseConfig);

    expect(result).toEqual({
      targets: [],
      targeted: true,
      content: "please check this",
      failure: {
        kind: "ambiguous_mention",
        detail: "@ops 匹配到多个实例，请先修正重复 tag",
      },
    });
  });

  test("broadcasts to all instances when multiple are online without @mention", () => {
    const instances = new Map<string, ConnectedInstance>([
      ["instance-1", makeInstance("instance-1", "ops")],
      ["instance-2", makeInstance("instance-2", "qa")],
    ]);

    const result = route(makeMessage("please handle this"), instances, baseConfig);

    expect(result).toEqual({
      targets: ["instance-1", "instance-2"],
      targeted: false,
      content: "please handle this",
    });
  });
});
