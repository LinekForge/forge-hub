# Forge Engine

**实验性定时行动引擎** — 按 schedule 给 Claude Code 发心跳、提醒、指令。让 agent 从"被动回应"变成"主动行动"。

独立的 channel MCP server，通过 [Channels 协议](https://code.claude.com/docs/en/channels-reference) 注入 Claude 上下文。和 Hub Server 配合：Hub 管通道（空间），Engine 管时间。

> [!IMPORTANT]
> Forge Engine 目前是 **experimental / manual setup**。源码、MCP server 和 CLI 都在仓库里，但 **`forge-hub install` 默认不会部署或注册它**。想用的话，按下面步骤单独配置。

## 运行日志与崩溃可见性

`log()` / `logError()` 除了写 stderr，**同时追加到 `<DATA_DIR>/engine.log`**，超过 2MB 转存 `engine.log.1`（只留一份）。

**为什么需要文件日志**：stderr 是给 MCP 宿主看的，但宿主通常只在**连接建立那一刻**捕获 stderr —— engine 启动之后打印的任何东西都不再被记录。一旦进程异常退出，什么线索都不剩。

实测案例（2026-09-03）：engine 在 00:00–03:00 之间消失，宿主日志无断开记录、系统无崩溃报告、无内存压力事件，调度静默停摆 **10 小时 31 分**、漏跑 12 个任务。事后无从判断死因。

**崩溃捕获**：`uncaughtException` 与 `unhandledRejection` 会把完整堆栈写进 `engine.log`，随后 `stopScheduler()` 释放 PID 锁并退出（exit 1）。

**为什么退出而不是继续跑**：调度器状态可能已损坏，而一个状态损坏的调度器发出的推送比不推送更坏。

**为什么不自动重起**：多实例 + 自动重起 + 抢 PID 锁是本项目已经踩过的坑（`cleanOrphans` + 一次性 `acquirePidLock` 的组合）。恢复由**外部**检测触发人工重连，engine 自己不做进程管理。

## 架构

```
engine.d/*.json (schedule 文件)
        │
        ▼
  scheduler.ts  ──▶  engine-channel.ts (MCP server)  ──▶  Claude Code session
        │                                                         │
        └── config-loader.ts (热加载)                              │
        └── handler-loader.ts (插件)                               │
                                                                   ▼
                                                          agent 收到通知后行动
```

| 文件 | 职责 |
|------|------|
| `engine-channel.ts` | MCP server 入口 + `engine_add_task` 工具 |
| `scheduler.ts` | 核心调度——expandRandom / fire / 午夜重算 / 热加载 / PID lock / `stopScheduler` |
| `config-loader.ts` | 配置加载 + fs.watch 热加载 |
| `handler-loader.ts` | 可插拔 handler（`handlers/` 目录下的自定义逻辑） |
| `template.ts` | 模板变量渲染（`{time}` `{weekday}` `{contacts}` 等） |
| `state.ts` | 持久化状态（任务 + pause） |
| `types.ts` | TypeScript 类型定义 |
| `config.ts` | 路径常量 + 日志 |

## PID Lock / Passive Mode

同一台机器上可能有多个 Claude Code session 各自 spawn 自己的 engine MCP server 进程。为避免重复调度，engine 用 PID 文件（`engine-data/engine.pid`）做排他锁：

- **第一个启动的实例**拿到锁，成为 **active**——正常排程、fire 定时任务。
- **后续实例**检测到锁已被一个活着的进程持有，自动进入 **passive mode**——MCP 工具（`engine_add_task`）照常可用，但不启动任何定时器，不重复触发任务。
- 如果持锁进程已退出（stale PID），新实例接管锁并成为 active。

Passive mode 对 agent 透明：工具调用不受影响，只是定时排程由唯一的 active 实例负责。

## Graceful Shutdown

engine-channel.ts 注册了 `SIGTERM` 和 `SIGINT` 信号处理：

1. 调用 `stopScheduler()` — 清除所有定时器（task timers + 午夜重排 + 热加载 debounce）
2. 释放 PID lock（只删自己持有的 `engine.pid`）
3. `process.exit(0)`

这保证 Claude Code 关窗口（launchd 或 MCP 父进程发 SIGTERM）时不会留下残余定时器或 stale PID 文件。

## Trigger Log Rotation

`engine-trigger-log.md`（记录每次任务触发的日志）支持自动轮转：

- 每次写入前检查文件大小，超过 **512 KB** 自动轮转。
- 保留 **2 个**轮转文件（`engine-trigger-log.md.1`、`engine-trigger-log.md.2`），更旧的自动删除。
- 轮转采用重命名链：当前 → `.1` → `.2`，不丢数据。

## 快速开始

```bash
cd forge-engine
bun install
```

1. 创建配置 `~/.forge-hub/engine-data/engine-config.json`：
```json
{
  "enabled": true,
  "scan_dir": true,
  "contacts": {}
}
```

2. 创建 schedule `~/.forge-hub/engine-data/engine.d/heartbeat.json`：
```json
{
  "type": "heartbeat",
  "wakeup": "7:00",
  "sleep": "23:00",
  "active_start": 9,
  "active_end": 22,
  "daily_count": 20
}
```

3. 注册 engine 为 Claude Code 的 MCP server（二选一）：

   **方式 A（推荐）**：CLI 一行注册（user scope，所有 session 共享）
   ```bash
   claude mcp add --transport stdio --scope user engine -- bun /absolute/path/to/forge-engine/engine-channel.ts
   ```

   **方式 B**：手写到 `~/.claude.json` 的 `mcpServers`
   ```json
   {
     "mcpServers": {
       "engine": {
         "command": "bun",
         "args": ["/absolute/path/to/forge-engine/engine-channel.ts"]
       }
     }
   }
   ```

4. **启动 Claude Code 时把 engine 加入 channels 白名单**——这一步**必不可少**，否则 engine 的定时通知会被 Claude Code 静默丢弃：

```bash
claude --dangerously-load-development-channels server:engine
```

> [!IMPORTANT]
> Channels 是 research preview（详见 [Channels Reference](https://code.claude.com/docs/en/channels-reference)），自定义 channel server（包括 forge-engine、forge-hub 的 hub-channel）必须用 `--dangerously-load-development-channels server:<name>` 显式白名单才被识别。`claude mcp list` 显示 `✓ Connected` **只代表 MCP 子进程成功启动**，**不代表 channel 通知能投递**——后者还需要这一步。
>
> 和 forge-hub 一起用要带两个，**空格分隔**：`server:hub server:engine`（不是逗号）。如果你用 [forge-launcher](https://github.com/LinekForge/forge-launcher) 启动菜单栏会话管理器，它会自动带上这俩 flag。

5. 验证 channel 通知接通：在跑 Claude Code 的窗口里让 agent 调用 `engine_add_task` 工具（设 `delay_seconds: 30`）。30 秒后窗口收到 `<channel source="engine" ...>` 包裹的消息说明白名单生效；收不到 → 检查是否漏了 `server:engine`。

6. 用 `fh engine` 管理任务：
```bash
fh engine list
fh engine pause 30
fh engine remove heartbeat.json
fh engine log "今天 14:00 已人工处理"
```

## Schedule 格式（v2 语义化）

每个 `engine.d/*.json` 文件有一个 `type` 字段，格式跟着 type 走。

### heartbeat — 心跳

```json
{
  "type": "heartbeat",
  "wakeup": "7:00",
  "sleep": "23:00",
  "active_start": 9,
  "active_end": 22,
  "daily_count": 20,
  "min_per_hour": 1
}
```

Engine 自动展开为：起床固定条目 + 睡觉固定条目 + N 条随机分布心跳。

### reminder — 提醒

```json
{
  "type": "reminder",
  "time": "14:00",
  "prompt": "Stand up and stretch."
}
```

多条写成 `tasks` 数组：

```json
{
  "type": "reminder",
  "weekdays": [1, 2, 3, 4, 5],
  "tasks": [
    { "time": "9:00", "prompt": "Morning standup" },
    { "time": "17:00", "prompt": "End of day review" }
  ]
}
```

### instruction — 定时指令

和 reminder 结构相同，默认 sender 是 `"instruction"`，默认 template 是 `[指令] {prompt}`。

### oneshot — 一次性任务

```json
{
  "type": "oneshot",
  "time": "15:30",
  "date": "2026-05-23",
  "prompt": "Call the dentist."
}
```

触发后自动删除文件。`engine_add_task` 工具创建的任务默认是这个格式。

### 老格式（向后兼容）

没有 `type` 字段的文件走 `{ "schedules": [...] }` 老格式，行为不变。

更多示例见 `examples/` 目录。

## CLI 删除行为

`fh engine remove <query>` 按文件级别删除——匹配到的任务所在的整个文件会被删掉。

这是设计决策，不是疏漏：

- AI 通过 `engine_add_task` 创建的任务都是单文件单任务（`oneshot_xxx.json` / `task_xxx.json`），删文件 = 删任务
- 手写的多条任务文件（如 awakening.json 里的多条指令）通常不用 CLI 删，而是直接编辑
- Scheduler 内部的 `removeScheduleEntryFromFile` 支持按条目索引删除单条（用于 one_shot 触发后自动删除），但 CLI 不走这条路径

如果以后需要按条目删除，可以扩展 CLI 加 `--entry <index>` 参数，复用 `removeScheduleEntryFromFile`。

## 工具

| 工具 | 说明 |
|------|------|
| `engine_add_task` | Claude 在 session 里动态添加定时任务（如"一小时后提醒我做 X"） |

> `engine_add_task` 只有在你按上面的步骤把 engine MCP server 单独注册进 Claude Code 之后才可用。

## Public API

| 导出 | 来源 | 说明 |
|------|------|------|
| `startScheduler(server)` | `scheduler.ts` | 启动调度（获取 PID lock、加载配置、排程、启动热加载） |
| `stopScheduler()` | `scheduler.ts` | 清除所有定时器（task timers + 午夜重排 + 热加载 debounce）、释放 PID lock。shutdown handler 内部调用 |

## Handler 插件

在 `handlers/` 目录下放 `.ts` 文件，export 一个 `ScheduleHandler` 接口实现。Engine 启动时自动扫描加载。

## License

[MIT](../LICENSE) — Linek & Forge
