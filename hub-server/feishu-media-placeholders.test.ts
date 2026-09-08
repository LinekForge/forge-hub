import { describe, expect, test } from "bun:test";

import { resolveImagePlaceholders } from "./channels/feishu-lark-cli.js";

/** 按 key 返回假路径；返回 null 模拟下载失败。 */
function fakeDownloader(failFor: string[] = []) {
  const calls: string[] = [];
  const download = async (key: string): Promise<string | null> => {
    calls.push(key);
    return failFor.includes(key) ? null : `/media/${key}.png`;
  };
  return { download, calls };
}

describe("resolveImagePlaceholders", () => {
  test("replaces a single placeholder with the downloaded path", async () => {
    const { download } = fakeDownloader();

    const out = await resolveImagePlaceholders("[图片: img_v3_aaa]", download);

    expect(out).toBe("[图片] /media/img_v3_aaa.png");
  });

  test("replaces every placeholder when one message carries several images", async () => {
    const { download, calls } = fakeDownloader();

    const out = await resolveImagePlaceholders(
      "[图片: img_v3_aaa][图片: img_v3_bbb][图片: img_v3_ccc]",
      download,
    );

    expect(calls).toEqual(["img_v3_aaa", "img_v3_bbb", "img_v3_ccc"]);
    expect(out).toBe(
      "[图片] /media/img_v3_aaa.png[图片] /media/img_v3_bbb.png[图片] /media/img_v3_ccc.png",
    );
  });

  test("keeps the surrounding text of a rich-text message", async () => {
    const { download } = fakeDownloader();

    const out = await resolveImagePlaceholders(
      "先看这张 [图片: img_v3_aaa] 再看这张 [图片: img_v3_bbb] 完",
      download,
    );

    expect(out).toBe(
      "先看这张 [图片] /media/img_v3_aaa.png 再看这张 [图片] /media/img_v3_bbb.png 完",
    );
  });

  test("accepts the English [Image: ...] form", async () => {
    const { download } = fakeDownloader();

    const out = await resolveImagePlaceholders("a [Image: img_v3_aaa] b", download);

    expect(out).toBe("a [图片] /media/img_v3_aaa.png b");
  });

  test("leaves the placeholder in place when the download fails", async () => {
    const { download } = fakeDownloader(["img_v3_bbb"]);

    const out = await resolveImagePlaceholders(
      "[图片: img_v3_aaa] 中间 [图片: img_v3_bbb]",
      download,
    );

    // 失败的那张保留原占位符，成功的那张照常替换——不因为一张失败就丢掉整条消息
    expect(out).toBe("[图片] /media/img_v3_aaa.png 中间 [图片: img_v3_bbb]");
  });

  test("returns text without placeholders untouched and downloads nothing", async () => {
    const { download, calls } = fakeDownloader();

    const out = await resolveImagePlaceholders("纯文字，没有图", download);

    expect(out).toBe("纯文字，没有图");
    expect(calls).toEqual([]);
  });
});
