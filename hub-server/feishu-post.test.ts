import { describe, expect, test } from "bun:test";

import { extractFeishuPostParts } from "./channels/feishu.js";

describe("extractFeishuPostParts", () => {
  test("拼接 post 富文本里的 text 并下载 file", async () => {
    const content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "text", text: "我应该关注什么 才能规划好赚大钱退休~" },
          {
            tag: "file",
            file_key: "file_v3_abc123",
            file_name: "数字广东十五五规划.pdf",
          },
        ],
      ],
    });
    const result = await extractFeishuPostParts(content, async (key, name) => {
      expect(key).toBe("file_v3_abc123");
      expect(name).toBe("数字广东十五五规划.pdf");
      return "/tmp/media/数字广东.pdf";
    });
    expect(result).toBe("我应该关注什么 才能规划好赚大钱退休~\n[文件] /tmp/media/数字广东.pdf");
  });

  test("纯 text 的 post 只返回文字、不调 download", async () => {
    const content = JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "记得更新看板卡片" }]],
    });
    let downloadCalled = 0;
    const result = await extractFeishuPostParts(content, async () => {
      downloadCalled += 1;
      return null;
    });
    expect(result).toBe("记得更新看板卡片");
    expect(downloadCalled).toBe(0);
  });

  test("file 下载失败时退化为 [文件: 名字]", async () => {
    const content = JSON.stringify({
      title: "",
      content: [[{ tag: "file", file_key: "file_v3_x", file_name: "资料.docx" }]],
    });
    const result = await extractFeishuPostParts(content, async () => null);
    expect(result).toBe("[文件: 资料.docx]");
  });

  test("多行富文本按序拼接", async () => {
    const content = JSON.stringify({
      title: "",
      content: [
        [{ tag: "text", text: "第一行" }],
        [{ tag: "text", text: "第二行" }],
      ],
    });
    const result = await extractFeishuPostParts(content, async () => null);
    expect(result).toBe("第一行\n第二行");
  });

  test("非 JSON content 返回空串", async () => {
    const result = await extractFeishuPostParts("not-json{{{", async () => null);
    expect(result).toBe("");
  });

  test("file_v2 标签同样处理", async () => {
    const content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "file_v2", file_key: "file_v3_v2", file_name: "新文件.pdf" },
        ],
      ],
    });
    const result = await extractFeishuPostParts(content, async () => "/tmp/media/新文件.pdf");
    expect(result).toBe("[文件] /tmp/media/新文件.pdf");
  });
});
