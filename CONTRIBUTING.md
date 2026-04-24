# Contributing to Forge Hub

谢谢想 contribute！下面是基本约定。

## 本地开发

```bash
git clone https://github.com/LinekForge/forge-hub.git
cd forge-hub
(cd hub-server && bun install)
(cd hub-client && bun install)
(cd forge-engine && bun install)
(cd hub-dashboard && bun install)
bun cli.ts doctor               # 自检（看缺什么依赖 / 凭证 / plist）
bun hub-test-harness/harness.ts # 直接跑 8 场景 harness
fh hub self-test                # 走对外 CLI 包装再跑一遍
```

改动后按影响范围跑：

```bash
bun test
bun hub-test-harness/harness.ts
(cd hub-server && ../hub-dashboard/node_modules/.bin/tsc -p tsconfig.json --noEmit)
(cd hub-client && ../hub-dashboard/node_modules/.bin/tsc -p tsconfig.json --noEmit)
(cd forge-engine && ../hub-dashboard/node_modules/.bin/tsc -p tsconfig.json --noEmit)
(cd hub-dashboard && bun run lint && bun run build)
fh hub self-test
```

## 报 Bug / 提需求

GitHub Issues。请带：
- 复现步骤（如果是 bug）
- `forge-hub doctor` 输出
- `~/.forge-hub/hub.log` 和 `~/.forge-hub/hub-stderr.log` 的相关片段
- macOS / Linux 版本 + Bun 版本

## 写新通道插件

参考 `hub-docs/channel-plugin-guide.md` + `examples/echo.ts`。

最小通道插件 ~150 行：
- 实现 `ChannelPlugin` 接口（`name`, `start`, `send`, `stop`）
- 在 `start()` 里调 hub.pushMessage(...) 把入站消息推给 Hub
- 在 `send()` 里把 hub 出站消息发到外部平台

写完丢到 `hub-server/channels/` 下任一 `.ts` 文件即可——Hub 启动时自动 hot load。

## Code 改动

- **跑两步 self-test**：`bun hub-test-harness/harness.ts` + `fh hub self-test`
- **不引入 silent failure**：catch 块至少 `logError(...)`，关键不变量（lock-phrase / allowlist / audit）写失败必须 throw 而不是 fail-open
- **不引入硬编码路径**：用 `which` 动态查找 + env var 覆盖
- **不引入私人 ID / 密钥**（test code 也不行）—— PR 自检：
  ```bash
  grep -rE '@im\.wechat|ou_[a-f0-9]{16,}|sk-ant-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9_-]{20,}|[0-9]{9,10}:[A-Za-z0-9_-]{35}' .
  ```
  覆盖：微信 sender_id、飞书 open_id、Anthropic API key、OpenAI-style key、Telegram bot token

## PR 流程

1. Fork → branch
2. 改 + 跑 `bun hub-test-harness/harness.ts` 和 `fh hub self-test`
3. PR 描述带：动机、改动概要、影响范围、self-test 结果

## 安全问题

不要发 public issue。通过 GitHub Security Advisory 提交 private report，详见 [SECURITY.md](SECURITY.md)。

## License

MIT。提交 PR 即同意你的代码以 MIT 开源。
