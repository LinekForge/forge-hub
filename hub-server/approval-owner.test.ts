import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-approval-tests-"));
process.env.FORGE_HUB_DIR = hubDir;

const {
  matchesApprovalOwner,
  idLookup,
  pendingPermissions,
  resolveApprovalFromDashboard,
  resolveApprovalRecipient,
  isApprovalOwner,
} = await import("./approval.js");
const { getInstances } = await import("./instance-manager.js");
const { saveChannelState } = await import("./state.js");
import { getAuthSenderId } from "./message-auth.js";
import type { ConnectedInstance, PendingPermission } from "./types.js";

function makeInstance(id: string, sendStatus: number): ConnectedInstance {
  return {
    id,
    connectedAt: new Date().toISOString(),
    ws: {} as ConnectedInstance["ws"],
    send() { return sendStatus; },
    close() {},
  };
}

function makePending(requestId: string): PendingPermission {
  return {
    request_id: requestId,
    yes_id: "abcde",
    no_id: "fghjk",
    tool_name: "run_command",
    description: "Run a command",
    input_preview: "echo hi",
    from_instance: "instance-1",
    created_at: Date.now(),
    pushed_channels: ["homeland"],
  };
}

function writeTestAllowlist(channel: string, data: unknown) {
  const dir = path.join(hubDir, "state", channel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "allowlist.json"), JSON.stringify(data, null, 2));
}

beforeEach(() => {
  pendingPermissions.clear();
  idLookup.clear();
  getInstances().clear();
  writeTestAllowlist("wechat", { allowed: [], auto_allow_next: false });
  writeTestAllowlist("imessage", { allowed: [], auto_allow_next: false });
});

afterAll(() => {
  fs.rmSync(hubDir, { recursive: true, force: true });
});

describe("approval owner matching", () => {
  test("matches only the explicitly configured owner", () => {
    expect(matchesApprovalOwner("wechat", "owner-1", "owner-1")).toBe(true);
    expect(matchesApprovalOwner("wechat", "owner-2", "owner-1")).toBe(false);
  });

  test("imessage approval owner matching is case-insensitive", () => {
    expect(matchesApprovalOwner("imessage", "user@icloud.com", "User@ICloud.com")).toBe(true);
  });

  test("resolveApprovalRecipient uses explicit approval owner instead of allowlist order", async () => {
    saveChannelState("wechat", "allowlist", {
      allowed: [
        { id: "group-chat", nickname: "群" },
        { id: "owner-1", nickname: "Owner" },
      ],
      auto_allow_next: false,
      approval_owner_id: "owner-1",
    });

    await expect(resolveApprovalRecipient("wechat")).resolves.toBe("owner-1");
  });

  test("isApprovalOwner rejects replies when approval owner is missing", () => {
    saveChannelState("wechat", "allowlist", {
      allowed: [{ id: "owner-1", nickname: "Owner" }],
      auto_allow_next: false,
    });

    expect(isApprovalOwner("wechat", "owner-1")).toEqual({
      ok: false,
      error: "approval owner not configured for wechat; run 'fh hub owner wechat <id>'",
    });
  });

  test("isApprovalOwner rejects configs whose owner is no longer in allowlist", () => {
    saveChannelState("wechat", "allowlist", {
      allowed: [{ id: "owner-2", nickname: "Owner 2" }],
      auto_allow_next: false,
      approval_owner_id: "owner-1",
    });

    expect(isApprovalOwner("wechat", "owner-1")).toEqual({
      ok: false,
      error: "approval owner owner-1 is not present in wechat allowlist",
    });
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

describe("resolveApprovalFromDashboard", () => {
  test("keeps pending state when delivery is not confirmed", () => {
    const pending = makePending("rq123");
    pendingPermissions.set(pending.request_id, pending);
    idLookup.set(pending.yes_id, { request_id: pending.request_id, behavior: "allow" });
    idLookup.set(pending.no_id, { request_id: pending.request_id, behavior: "deny" });
    getInstances().set("instance-1", makeInstance("instance-1", 0));

    const result = resolveApprovalFromDashboard(pending.request_id, "allow");

    expect(result).toEqual({
      ok: false,
      error: "failed to deliver approval to instance-1",
      status: 503,
    });
    expect(pendingPermissions.has(pending.request_id)).toBe(true);
    expect(idLookup.has(pending.yes_id)).toBe(true);
    expect(idLookup.has(pending.no_id)).toBe(true);
  });

  test("clears pending state after a confirmed delivery", () => {
    const pending = makePending("rq456");
    pendingPermissions.set(pending.request_id, pending);
    idLookup.set(pending.yes_id, { request_id: pending.request_id, behavior: "allow" });
    idLookup.set(pending.no_id, { request_id: pending.request_id, behavior: "deny" });
    getInstances().set("instance-1", makeInstance("instance-1", 12));

    const result = resolveApprovalFromDashboard(pending.request_id, "deny");

    expect(result).toEqual({ ok: true, action: "deny" });
    expect(pendingPermissions.has(pending.request_id)).toBe(false);
    expect(idLookup.has(pending.yes_id)).toBe(false);
    expect(idLookup.has(pending.no_id)).toBe(false);
  });
});
