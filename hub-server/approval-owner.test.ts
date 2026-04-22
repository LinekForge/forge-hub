import { describe, expect, test } from "bun:test";

import { matchesApprovalOwner } from "./approval.js";
import { getAuthSenderId } from "./message-auth.js";

describe("approval owner matching", () => {
  test("only the first allowlist entry can approve", () => {
    const allowed = [
      { id: "owner-1" },
      { id: "owner-2" },
    ];

    expect(matchesApprovalOwner("wechat", "owner-1", allowed)).toBe(true);
    expect(matchesApprovalOwner("wechat", "owner-2", allowed)).toBe(false);
  });

  test("imessage approval owner matching is case-insensitive", () => {
    const allowed = [{ id: "User@ICloud.com" }];

    expect(matchesApprovalOwner("imessage", "user@icloud.com", allowed)).toBe(true);
  });
});

describe("getAuthSenderId", () => {
  test("prefers explicit auth_sender_id when present", () => {
    const senderId = getAuthSenderId({
      channel: "feishu",
      from: "群消息",
      fromId: "oc_123",
      content: "hello",
      raw: { auth_sender_id: "ou_456", sender_id: "ou_456" },
    });

    expect(senderId).toBe("ou_456");
  });

  test("falls back to imessage handle_id before reply target id", () => {
    const senderId = getAuthSenderId({
      channel: "imessage",
      from: "用户",
      fromId: "iMessage;-;+15551234567",
      content: "hello",
      raw: { handle_id: "+15551234567" },
    });

    expect(senderId).toBe("+15551234567");
  });
});
