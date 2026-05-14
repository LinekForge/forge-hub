import { describe, expect, test } from "bun:test";

import { __test__ } from "./channels/wechat.js";
import { MSG_TYPE_USER } from "./channels/wechat-types.js";
import type { WeixinMessage } from "./channels/wechat-types.js";
import type { RecordUnauthorizedOpts } from "./evidence.js";
import type { HubAPI } from "./types.js";

function fakeHubAPI(overrides: Partial<HubAPI> = {}): HubAPI {
  return {
    pushMessage() {},
    getState() { return null; },
    setState() {},
    log() {},
    logError() {},
    formatUnauthorizedNotice() { return ""; },
    async resolveAsr() { return null; },
    isAllowed() { return false; },
    getNickname(senderId: string) { return senderId; },
    recordSecurityEvent() {},
    ...overrides,
  };
}

describe("wechat unauthorized media guard", () => {
  test("records unauthorized media evidence without downloading the attachment", async () => {
    let downloadCalls = 0;
    const evidenceInputs: { contentType: string; contentMeta: Record<string, unknown> }[] = [];
    const securityEvents: unknown[] = [];

    const msg: WeixinMessage = {
      message_type: MSG_TYPE_USER,
      message_id: "wx-msg-unauth-media",
      from_user_id: "attacker@im.wechat",
      item_list: [
        {
          type: 2,
          image_item: {
            aeskey: "00112233445566778899aabbccddeeff",
            media: { encrypt_query_param: "download-token" },
          },
        },
      ],
    };

    await __test__.handleWechatUserMessage(msg, {
      hubApi: fakeHubAPI({
        isAllowed() { return false; },
        recordSecurityEvent(event) { securityEvents.push(event); },
      }),
      downloadMedia: async () => {
        downloadCalls += 1;
        return { type: "image", filePath: "/tmp/should-not-exist", fileName: "x.jpg" } as any;
      },
      recordUnauthorized: ((input: RecordUnauthorizedOpts) => {
        evidenceInputs.push({ contentType: input.contentType, contentMeta: input.contentMeta });
        return { evidence_id: "ev-unauth-media" } as any;
      }) as any,
      startTypingFn: () => {
        throw new Error("unauthorized messages must not start typing");
      },
    });

    expect(downloadCalls).toBe(0);
    expect(evidenceInputs[0]).toEqual({
      contentType: "image",
      contentMeta: { content_type: "image", item_count: 1 },
    });
    expect(securityEvents).toEqual([
      {
        sourceUserId: "attacker@im.wechat",
        contentType: "image",
        evidenceId: "ev-unauth-media",
      },
    ]);
  });
});
