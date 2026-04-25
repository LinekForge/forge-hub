import { describe, test, expect } from "bun:test";
import { chunkText } from "./channels/wechat-ilink.js";

// stripMarkdown is module-private, so we duplicate the function here for testing.
// Keep in sync with wechat.ts.
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").replace(/```$/g, ""))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, "$1")
    .replace(/(?<!\w)_([^_]+?)_(?!\w)/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[>\s]*>\s?/gm, "")
    .replace(/^[-*+]\s+/gm, "• ")
    .replace(/^\d+\.\s+/gm, (m) => m);
}

describe("chunkText", () => {
  test("short text returns single chunk", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  test("empty string returns single empty chunk", () => {
    expect(chunkText("", 100)).toEqual([""]);
  });

  test("text exactly at limit returns single chunk", () => {
    const text = "a".repeat(100);
    expect(chunkText(text, 100)).toEqual([text]);
  });

  test("splits on paragraph boundary", () => {
    const text = "a".repeat(60) + "\n\n" + "b".repeat(60);
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(60));
    expect(chunks[1]).toBe("b".repeat(60));
  });

  test("splits on newline when no paragraph break", () => {
    const text = "a".repeat(60) + "\n" + "b".repeat(60);
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(60));
    expect(chunks[1]).toBe("b".repeat(60));
  });

  test("hard cut when no natural boundary", () => {
    const text = "a".repeat(150);
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(100);
    expect(chunks[1].length).toBe(50);
  });

  test("chinese text without spaces hard-cuts", () => {
    const text = "测".repeat(150);
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(100);
  });

  test("does not split too early (minSplit 30%)", () => {
    const text = " " + "a".repeat(150);
    const chunks = chunkText(text, 100);
    // The space is at position 0 which is < 30% of 100, so it should not split there
    expect(chunks[0].length).toBeGreaterThan(30);
  });
});

describe("stripMarkdown", () => {
  test("removes bold markers", () => {
    expect(stripMarkdown("this is **bold** text")).toBe("this is bold text");
  });

  test("removes double underscore bold", () => {
    expect(stripMarkdown("this is __bold__ text")).toBe("this is bold text");
  });

  test("removes italic at word boundary", () => {
    expect(stripMarkdown("this is *italic* text")).toBe("this is italic text");
  });

  test("preserves underscores inside identifiers", () => {
    expect(stripMarkdown("use foo_bar_baz")).toBe("use foo_bar_baz");
  });

  test("preserves asterisks inside identifiers", () => {
    expect(stripMarkdown("a*b*c")).toBe("a*b*c");
  });

  test("preserves path-like underscores", () => {
    expect(stripMarkdown("path a_b/c_d")).toBe("path a_b/c_d");
  });

  test("removes strikethrough", () => {
    expect(stripMarkdown("this is ~~deleted~~ text")).toBe("this is deleted text");
  });

  test("removes heading markers", () => {
    expect(stripMarkdown("## Heading\ntext")).toBe("Heading\ntext");
  });

  test("removes link syntax preserving text", () => {
    expect(stripMarkdown("click [here](http://example.com)")).toBe("click here");
  });

  test("strips code fences preserving content", () => {
    expect(stripMarkdown("```js\nconst x = 1;\n```")).toBe("const x = 1;\n");
  });

  test("converts list markers to bullets", () => {
    expect(stripMarkdown("- item 1\n- item 2")).toBe("• item 1\n• item 2");
  });

  test("removes blockquote markers", () => {
    expect(stripMarkdown("> quoted text")).toBe("quoted text");
  });
});
