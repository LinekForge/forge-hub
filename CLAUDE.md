# CLAUDE.md

为 Claude Code (claude.ai/code) 提供本仓库的工作指引。

## 项目概览

Forge Hub 是 Claude Code 的多通道消息总线。把微信、Telegram、飞书、iMessage、本地 Dashboard 五个通道的消息路由到 Claude Code 实例，并处理远程审批转发。

- **运行时**：Bun（不是 Node.js）
- **语言**：TypeScript，全局 strict mode
- **无构建步骤**：server/client/cli/engine 由 Bun 直接跑 TS；只有 `hub-dashboard` 需要 Vite 构建

## Monorepo 结构

| 模块 | 成熟度 | 说明 |
|------|--------|------|
| `hub-server/` | 稳定主线 | 消息路由、审批、安全防线、通道管理。HTTP 路由拆分在 `hub-server/routes/`（health/send/approval/instances/homeland/dashboard），`endpoints.ts` 只做鉴权 + 分发 |
| `hub-client/` | 稳定主线 | Claude Code MCP channel（4 个工具：hub_reply / hub_send_file / hub_send_voice / hub_replay_history） |
| `forge-cli/` | 稳定主线 | 日常管理 CLI（`fh hub ...` / `fh engine ...`） |
| `cli.ts` | 稳定主线 | 安装入口（`forge-hub install / uninstall / doctor`） |
| `hub-test-harness/` | 稳定主线 | 隔离端到端测试（8 场景，端口 9901） |
| `hub-dashboard/` | 已部署 UI | React + Tailwind + Zustand（仍在迭代） |
| `hub-app/` | Preview | macOS 原生客户端（Swift） |
| `forge-engine/` | 实验性 | 定时任务引擎（默认不启用） |

## 构建与测试命令

各模块验证（从仓库根目录执行）：

```bash
# hub-server：类型检查 + 单元测试
(cd hub-server && bun install && bunx tsc --noEmit && bun test)

# hub-client：类型检查 + 单元测试
(cd hub-client && bun install && bunx tsc --noEmit && bun test)

# forge-cli：单元测试
(cd forge-cli && bun test)

# forge-engine：类型检查 + 单元测试
(cd forge-engine && bun install && bunx tsc --noEmit && bun test)

# hub-dashboard：lint + 构建
(cd hub-dashboard && bun install && bun run lint && bun run build)

# 集成测试
bun hub-test-harness/harness.ts    # 8 场景 harness（在 :9901 启动隔离 Hub）
fh hub self-test                    # 完整端到端（需要运行中的 Hub）
```

## 关键约定

- **安全失败必须 fail-closed**：lock / allowlist / audit / evidence 写失败必须 throw 或 fallback，不能静默放过
- **未授权消息不进主 context**：走 evidence vault + security event 聚合，通知最多 1 条/小时极简提醒
- **外来字段必须净化**：display name / 文件名 / caption 进 LLM 可见文本前走 `sanitize.ts`（Unicode 清洗 + entity-encode + truncate）
- **不允许静默失败**：catch 块至少 `logError(...)`
- **不硬编码路径**：用 `which` 动态查找 + env var 覆盖
- **代码中不出现私人 ID / 密钥**（测试也不行）。PR 自检：
  ```bash
  grep -rE '@im\.wechat|ou_[a-f0-9]{16,}|sk-ant-[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9_-]{20,}|[0-9]{9,10}:[A-Za-z0-9_-]{35}' .
  ```
- **测试隔离**：所有测试通过 `test-setup.ts` 把 `FORGE_HUB_DIR` 重定向到 `/tmp`
- **热重载**：仅开发模式（`FORGE_HUB_DEV=1`），生产环境需要重启 Hub

## 公共契约（不可轻易变更）

跨模块边界。变更前必须检查所有调用方、测试和文档：

- `ChannelPlugin` / `HubAPI` 接口（`hub-server/types.ts`）
- `InboundMessage` / `SendParams` / `SendResult` 类型
- HTTP / WebSocket 端点（`hub-server/endpoints.ts` 鉴权 + 分发，业务逻辑在 `hub-server/routes/`）
- MCP 工具（`hub-client/hub-channel.ts`）
- Allowlist schema（`state/{channel}/allowlist.json`）
- Pending 审批 schema（`state/_hub/pending.json`）
- 运行时路径（见 @部署.md 和 @运行时状态.md）

## 文档索引

改动前先读对应文档：

| 改动范围 | 先读 |
|----------|------|
| 架构与数据流 | @架构.md |
| 维护边界与成熟度 | @维护地图.md |
| 通道凭证、ASR/TTS、token | @配置.md |
| 安装/升级/卸载、源码到运行时映射 | @部署.md |
| 运行时目录与文件 schema | @运行时状态.md |
| 安全模型与威胁边界 | @SECURITY.md |
| 新通道插件开发 | @hub-docs/channel-plugin-guide.md |
| 本地开发与 PR 流程 | @CONTRIBUTING.md |
| hub-client 模式判定与进程生命周期 | @hub-client/README.md |

## 运维工具

| 命令 | 用途 |
|------|------|
| `bash scripts/check-runtime-sync.sh` | 检查 OSS 和运行时是否同步 |
| `bash scripts/sync-to-runtime.sh` | 单向同步 OSS → 运行时 + 可选重启 Hub |
| `fh hub ps` | 查看 hub-channel 进程状态、PID、模式、孤儿检测 |
| `fh hub security [events\|evidence]` | 查看安全事件和 evidence 记录 |
