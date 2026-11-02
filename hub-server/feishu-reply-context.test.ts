import { describe, expect, test } from "bun:test";

import { formatReplyContext } from "./channels/feishu-lark-cli.js";

describe("formatReplyContext", () => {
  test("prefixes the quoted parent text so the agent knows what is being replied to", () => {
    const out = formatReplyContext("哪两条没有？", "om_parent", "第二条");

    expect(out).toBe("[回复 ▸ 哪两条没有？]\n第二条");
  });

  test("collapses newlines inside the quoted text into single spaces", () => {
    const out = formatReplyContext("第一行\n\n第二行\t第三行", "om_parent", "好");

    expect(out).toBe("[回复 ▸ 第一行 第二行 第三行]\n好");
  });

  test("truncates a long quoted text to 200 chars with an ellipsis", () => {
    const parent = "字".repeat(300);

    const out = formatReplyContext(parent, "om_parent", "收到");

    expect(out).toBe(`[回复 ▸ ${"字".repeat(200)}…]\n收到`);
  });

  test("does not add an ellipsis when the quoted text is exactly at the limit", () => {
    const parent = "x".repeat(200);

    const out = formatReplyContext(parent, "om_parent", "ok");

    expect(out).toBe(`[回复 ▸ ${parent}]\nok`);
  });

  test("falls back to the parent id when the parent text could not be fetched", () => {
    const out = formatReplyContext(null, "om_0000000000000000000000000000ffff", "试试");

    expect(out).toBe("[回复 om_0000000000000000000000000000ffff]\n试试");
  });

  test("keeps the user's own content untouched, including its newlines", () => {
    const out = formatReplyContext("原句", "om_parent", "第一段\n第二段");

    expect(out).toBe("[回复 ▸ 原句]\n第一段\n第二段");
  });
});
