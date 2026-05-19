import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "forge-hub-approval-unit-"));
process.env.FORGE_HUB_DIR = hubDir;

const {
  genDisplayId,
  genDisplayIdPair,
  PERMISSION_ID_RE,
  LOOSE_PERMISSION_ID_RE,
  PERMISSION_TTL_MS,
  clearPendingApproval,
  dismissApprovalFromDashboard,
  resolveApprovalFromDashboard,
  sendPendingApprovalResponse,
  pendingPermissions,
  idLookup,
} = await import("./approval.js");
const { getInstances } = await import("./instance-manager.js");
const { setCurrentConfig } = await import("./hub-state.js");
const { drainQueuedWrites } = await import("./write-queue.js");
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

function makePending(requestId: string, overrides?: Partial<PendingPermission>): PendingPermission {
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
    ...overrides,
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
  setCurrentConfig({
    port: 9900,
    host: "127.0.0.1",
    primary_instance: "",
    show_instance_tag: false,
    approval_channels: ["wechat"],
  });
  writeTestAllowlist("wechat", { allowed: [], auto_allow_next: false });
});

afterAll(async () => {
  await drainQueuedWrites();
  fs.rmSync(hubDir, { recursive: true, force: true });
});

// ── genDisplayId ────────────────────────────────────────────────────────────

describe("genDisplayId", () => {
  test("returns a 5-character string", () => {
    const id = genDisplayId();
    expect(id).toHaveLength(5);
  });

  test("only uses the allowed alphabet (a-z minus l)", () => {
    const allowed = "abcdefghijkmnopqrstuvwxyz";
    // generate many to have good coverage
    for (let i = 0; i < 200; i++) {
      const id = genDisplayId();
      for (const ch of id) {
        expect(allowed).toContain(ch);
      }
    }
  });

  test("never contains the letter l", () => {
    for (let i = 0; i < 500; i++) {
      expect(genDisplayId()).not.toContain("l");
    }
  });

  test("generates different IDs (not deterministic)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(genDisplayId());
    }
    // 25^5 ≈ 9.7M space; 50 draws should have near-zero collisions
    expect(ids.size).toBeGreaterThan(40);
  });
});

// ── genDisplayIdPair ────────────────────────────────────────────────────────

describe("genDisplayIdPair", () => {
  test("returns two distinct IDs", () => {
    const { yes_id, no_id } = genDisplayIdPair();
    expect(yes_id).toHaveLength(5);
    expect(no_id).toHaveLength(5);
    expect(yes_id).not.toBe(no_id);
  });

  test("avoids IDs already in idLookup", () => {
    // stuff the lookup with a known ID; the pair must not reuse it
    idLookup.set("aaaaa", { request_id: "existing", behavior: "allow" });
    for (let i = 0; i < 100; i++) {
      const { yes_id, no_id } = genDisplayIdPair();
      expect(yes_id).not.toBe("aaaaa");
      expect(no_id).not.toBe("aaaaa");
    }
  });
});

// ── PERMISSION_ID_RE ────────────────────────────────────────────────────────

describe("PERMISSION_ID_RE", () => {
  const valid = [
    "y abcde",
    "yes abcde",
    "n fghjk",
    "no fghjk",
    "Y ABCDE",
    "YES ABCDE",
    "No FGHJK",
    "  yes abcde  ",
  ];
  for (const input of valid) {
    test(`matches valid: "${input}"`, () => {
      expect(PERMISSION_ID_RE.test(input)).toBe(true);
    });
  }

  const invalid = [
    "yes abcdel",     // 6 chars (contains l is irrelevant; length matters)
    "yes abcd",       // 4 chars
    "yes",            // no id
    "maybe abcde",    // wrong verdict word
    "yes abc de",     // space in id
    "yes 12345",      // digits not allowed
    "yesabcde",       // no space
  ];
  for (const input of invalid) {
    test(`rejects invalid: "${input}"`, () => {
      expect(PERMISSION_ID_RE.test(input)).toBe(false);
    });
  }

  test("captures verdict and id groups", () => {
    const m = "yes fghjk".match(PERMISSION_ID_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("yes");
    expect(m![2]).toBe("fghjk");
  });

  test("id containing l is rejected (l excluded from alphabet)", () => {
    // the regex [a-km-z] explicitly skips l
    expect(PERMISSION_ID_RE.test("yes abcle")).toBe(false);
  });
});

// ── LOOSE_PERMISSION_ID_RE ──────────────────────────────────────────────────

describe("LOOSE_PERMISSION_ID_RE", () => {
  test("matches well-formed approval replies", () => {
    expect(LOOSE_PERMISSION_ID_RE.test("yes abcde")).toBe(true);
    expect(LOOSE_PERMISSION_ID_RE.test("no fghjk")).toBe(true);
  });

  test("matches ids containing l (which strict regex rejects)", () => {
    expect(LOOSE_PERMISSION_ID_RE.test("yes abcle")).toBe(true);
    // strict rejects it
    expect(PERMISSION_ID_RE.test("yes abcle")).toBe(false);
  });

  test("matches ids with wrong length (1-10 letters)", () => {
    expect(LOOSE_PERMISSION_ID_RE.test("no dhefjd")).toBe(true);  // 6 letters
    expect(LOOSE_PERMISSION_ID_RE.test("yes abc")).toBe(true);    // 3 letters
    expect(LOOSE_PERMISSION_ID_RE.test("yes a")).toBe(true);      // 1 letter
  });

  test("rejects ids longer than 10 chars", () => {
    expect(LOOSE_PERMISSION_ID_RE.test("yes abcdefghijk")).toBe(false); // 11 letters
  });

  test("rejects non-approval text", () => {
    expect(LOOSE_PERMISSION_ID_RE.test("hello world")).toBe(false);
    expect(LOOSE_PERMISSION_ID_RE.test("sure thing")).toBe(false);
    expect(LOOSE_PERMISSION_ID_RE.test("")).toBe(false);
  });
});

// ── clearPendingApproval ────────────────────────────────────────────────────

describe("clearPendingApproval", () => {
  test("removes request from pendingPermissions and both ids from idLookup", () => {
    const pending = makePending("rq-clear");
    pendingPermissions.set(pending.request_id, pending);
    idLookup.set(pending.yes_id, { request_id: pending.request_id, behavior: "allow" });
    idLookup.set(pending.no_id, { request_id: pending.request_id, behavior: "deny" });

    clearPendingApproval(pending.request_id, pending);

    expect(pendingPermissions.has(pending.request_id)).toBe(false);
    expect(idLookup.has(pending.yes_id)).toBe(false);
    expect(idLookup.has(pending.no_id)).toBe(false);
  });

  test("does not affect other pending entries", () => {
    const p1 = makePending("rq-1", { yes_id: "aaaaa", no_id: "bbbbb" });
    const p2 = makePending("rq-2", { yes_id: "ccccc", no_id: "ddddd" });
    pendingPermissions.set(p1.request_id, p1);
    pendingPermissions.set(p2.request_id, p2);
    idLookup.set(p1.yes_id, { request_id: p1.request_id, behavior: "allow" });
    idLookup.set(p1.no_id, { request_id: p1.request_id, behavior: "deny" });
    idLookup.set(p2.yes_id, { request_id: p2.request_id, behavior: "allow" });
    idLookup.set(p2.no_id, { request_id: p2.request_id, behavior: "deny" });

    clearPendingApproval(p1.request_id, p1);

    expect(pendingPermissions.has(p1.request_id)).toBe(false);
    expect(pendingPermissions.has(p2.request_id)).toBe(true);
    expect(idLookup.has(p2.yes_id)).toBe(true);
    expect(idLookup.has(p2.no_id)).toBe(true);
  });
});

// ── dismissApprovalFromDashboard ────────────────────────────────────────────

describe("dismissApprovalFromDashboard", () => {
  test("returns 404 when request does not exist", () => {
    const result = dismissApprovalFromDashboard("nonexistent");
    expect(result).toEqual({ ok: false, error: "pending not found", status: 404 });
  });

  test("clears pending state and returns dismissed", () => {
    const pending = makePending("rq-dismiss");
    pendingPermissions.set(pending.request_id, pending);
    idLookup.set(pending.yes_id, { request_id: pending.request_id, behavior: "allow" });
    idLookup.set(pending.no_id, { request_id: pending.request_id, behavior: "deny" });

    const result = dismissApprovalFromDashboard(pending.request_id);

    expect(result).toEqual({ ok: true, action: "dismissed" });
    expect(pendingPermissions.has(pending.request_id)).toBe(false);
    expect(idLookup.has(pending.yes_id)).toBe(false);
    expect(idLookup.has(pending.no_id)).toBe(false);
  });
});

// ── resolveApprovalFromDashboard (not-found case) ───────────────────────────

describe("resolveApprovalFromDashboard", () => {
  test("returns 404 when request does not exist", () => {
    const result = resolveApprovalFromDashboard("nonexistent", "allow");
    expect(result).toEqual({ ok: false, error: "pending not found", status: 404 });
  });

  test("returns 409 when instance is offline", () => {
    const pending = makePending("rq-offline-dash");
    pendingPermissions.set(pending.request_id, pending);
    // no instance registered → offline

    const result = resolveApprovalFromDashboard(pending.request_id, "allow");
    expect(result).toEqual({
      ok: false,
      error: `instance ${pending.from_instance} is offline`,
      status: 409,
    });
  });
});

// ── sendPendingApprovalResponse (backpressure) ──────────────────────────────

describe("sendPendingApprovalResponse", () => {
  test("reports backpressure when send returns negative", () => {
    const pending = makePending("rq-bp");
    pendingPermissions.set(pending.request_id, pending);
    getInstances().set("instance-1", makeInstance("instance-1", -1));

    const result = sendPendingApprovalResponse(pending.request_id, pending, "allow", {
      channel: "wechat",
      from: "Owner",
      fromId: "owner-1",
    });

    expect(result).toEqual({ ok: false, reason: "backpressure", sendStatus: -1 });
  });

  test("reports success with sendStatus when positive", () => {
    const pending = makePending("rq-ok");
    pendingPermissions.set(pending.request_id, pending);
    getInstances().set("instance-1", makeInstance("instance-1", 42));

    const result = sendPendingApprovalResponse(pending.request_id, pending, "deny", {
      channel: "homeland",
      from: "Operator",
      fromId: "local://operator",
    });

    expect(result).toEqual({ ok: true, sendStatus: 42 });
  });
});

// ── PERMISSION_TTL_MS constant ──────────────────────────────────────────────

describe("PERMISSION_TTL_MS", () => {
  test("is 4 hours in milliseconds", () => {
    expect(PERMISSION_TTL_MS).toBe(240 * 60 * 1000);
  });
});
