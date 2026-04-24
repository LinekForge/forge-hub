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

## 维护入口

动手前先按影响范围读文档：

| 要改什么 | 先看哪里 |
|----------|----------|
| 项目整体边界 / 成熟度 / 公共契约 | [维护地图.md](维护地图.md) |
| Hub Server / Hub Client / 通道数据流 | [架构.md](架构.md) |
| 通道凭证 / ASR / TTS / token / launchd env | [配置.md](配置.md) |
| 安装、升级、运行时复制关系 | [部署.md](部署.md) |
| `~/.forge-hub/` 下的状态文件和 schema | [运行时状态.md](运行时状态.md) |
| 新通道插件 | [hub-docs/channel-plugin-guide.md](hub-docs/channel-plugin-guide.md) |
| 安全边界 / 漏洞报告 | [SECURITY.md](SECURITY.md) |

成熟度按 [维护地图.md](维护地图.md) 处理：`hub-server`、`hub-client`、`forge-cli`、`cli.ts`、`hub-test-harness` 是 stable core；`hub-dashboard` 已进入默认安装但仍在迭代；`hub-app` 是 preview；`forge-engine` 是 experimental / manual setup。

## 改动验证

按影响范围跑最小验证；不确定时跑更大的集合。

| 改动范围 | 建议验证 |
|----------|----------|
| `hub-server/` 路由、审批、allowlist、lock、history | `(cd hub-server && bun install && bunx tsc --noEmit && bun test)` + `bun hub-test-harness/harness.ts` |
| 远程审批主流程 / 第二道防线 / harness 相关 | 上一行 + `fh hub self-test` |
| `hub-client/` | `(cd hub-client && bun install && bunx tsc --noEmit)`；涉及实际 channel 行为时手动跑 Claude Code channel |
| `forge-cli/` | `(cd forge-cli && bun test)` |
| `cli.ts` / install / uninstall / doctor | `bun cli.ts doctor`；涉及部署副作用时用临时 HOME 或明确手工记录 |
| `forge-engine/` | `(cd forge-engine && bun install && bunx tsc --noEmit && bun test)` |
| `hub-dashboard/` | `(cd hub-dashboard && bun install && bun run lint && bun run build)` |
| 新通道插件 | 插件手工记录：授权入站、未授权拦截、出站成功、stop 清理；能接 harness 的尽量接 |
| 文档-only | `git -c core.quotepath=false status --short --untracked-files=all` 确认只列文档；命令和链接要能对应到当前 repo |

全量本地验证参考：

```bash
(cd hub-server && bun install && bunx tsc --noEmit && bun test)
(cd hub-client && bun install && bunx tsc --noEmit)
(cd forge-cli && bun test)
(cd forge-engine && bun install && bunx tsc --noEmit && bun test)
(cd hub-dashboard && bun install && bun run lint && bun run build)
bun hub-test-harness/harness.ts
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

写完丢到 `hub-server/channels/` 下任一 `.ts` 文件即可——Hub 启动时会自动加载。生产模式默认不热加载；开发时用 `FORGE_HUB_DEV=1 bun hub-server/hub.ts` 才会监听文件变化。

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
