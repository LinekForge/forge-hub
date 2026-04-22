# Forge Engine

**实验性定时行动引擎** — 按 schedule 给 Claude Code 发心跳、提醒、指令。让 agent 从"被动回应"变成"主动行动"。

独立的 channel MCP server，通过 [Channels 协议](https://code.claude.com/docs/en/channels-reference) 注入 Claude 上下文。和 Hub Server 配合：Hub 管通道（空间），Engine 管时间。

> [!IMPORTANT]
> Forge Engine 目前是 **experimental / manual setup**。源码、MCP server 和 CLI 都在仓库里，但 **`forge-hub install` 默认不会部署或注册它**。想用的话，按下面步骤单独配置。

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
| `scheduler.ts` | 核心调度——expandRandom / fire / 午夜重算 / 热加载 |
| `config-loader.ts` | 配置加载 + fs.watch 热加载 |
| `handler-loader.ts` | 可插拔 handler（`handlers/` 目录下的自定义逻辑） |
| `template.ts` | 模板变量渲染（`{time}` `{weekday}` `{contacts}` 等） |
| `state.ts` | 持久化状态（任务 + pause） |
| `types.ts` | TypeScript 类型定义 |
| `config.ts` | 路径常量 + 日志 |

## 快速开始

```bash
cd forge-engine
bun install
```

1. 创建配置 `~/.claude/channels/engine/engine-config.json`：
```json
{
  "enabled": true,
  "scan_dir": true,
  "contacts": {}
}
```

2. 创建 schedule `~/.claude/channels/engine/engine.d/heartbeat.json`：
```json
{
  "schedules": [
    {
      "hour": 9,
      "minute": 0,
      "template": "[heartbeat] Good morning! It's {time} on {weekday}.",
      "sender": "heartbeat",
      "label": "morning"
    }
  ]
}
```

3. 注册为 Claude Code MCP server（`.claude.json` 或 `claude_desktop_config.json`）：
```json
{
  "mcpServers": {
    "engine": {
      "command": "bun",
      "args": ["path/to/forge-engine/engine-channel.ts"]
    }
  }
}
```

4. 用 `fh engine` 管理任务：
```bash
fh engine list
fh engine pause 30
fh engine remove heartbeat.json
fh engine log "今天 14:00 已人工处理"
```

## Schedule 格式

每个 `engine.d/*.json` 文件包含一个 `schedules` 数组，每条 entry：

| 字段 | 类型 | 说明 |
|------|------|------|
| `hour` | number | 小时（0-23） |
| `minute` | number | 分钟（0-59） |
| `template` | string | 消息模板，支持 `{time}` `{weekday}` `{label}` `{contacts}` `{prompt}` |
| `sender` | string | 消息来源标识（`heartbeat` / `reminder` / `instruction`） |
| `label` | string? | 可选标签 |
| `prompt` | string? | 可选 prompt（`{prompt}` 模板变量引用） |
| `expand` | `"random"`? | 设为 `"random"` 时按 `daily_count` + `active_start/end` 在一天内随机分布 |
| `weekdays` | number[]? | 限定星期几触发（0=周日，1=周一...6=周六） |

### 随机分布 schedule

```json
{
  "expand": "random",
  "hour": 0, "minute": 0,
  "active_start": 8,
  "active_end": 22,
  "daily_count": 5,
  "min_per_hour": 1,
  "template": "[heartbeat] It's {time}. Check in with the user.",
  "sender": "heartbeat"
}
```

每天 0:00 按 `daily_count` 在 `active_start`–`active_end` 范围内随机生成 N 个时间点。

## 工具

| 工具 | 说明 |
|------|------|
| `engine_add_task` | Claude 在 session 里动态添加定时任务（如"一小时后提醒我做 X"） |

> `engine_add_task` 只有在你按上面的步骤把 engine MCP server 单独注册进 Claude Code 之后才可用。

## Handler 插件

在 `handlers/` 目录下放 `.ts` 文件，export 一个 `ScheduleHandler` 接口实现。Engine 启动时自动扫描加载。

## License

[MIT](../LICENSE) — Linek & Forge
