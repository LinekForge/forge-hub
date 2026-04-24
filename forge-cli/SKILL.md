# forge CLI

forge-hub 命令行管理工具。通过 Bash 调用。

## 观测（read-only，随时能跑）

- `fh hub status` — Hub 状态（运行时间、在线实例数、已加载通道）
- `fh hub health` — 详细健康检查（每通道 consecutive failures / last error / degraded?）
- `fh hub peers` — 在线实例列表和工作描述
- `fh hub channels` — 已加载的通道插件
- `fh hub pending` — 当前挂起的审批队列
- `fh hub allowlist [channel]` — 查看所有通道的授权列表，或指定通道
- `fh hub replay <channel> [count=50] [since_ts]` — 查某通道最近 N 条聊天历史
- `fh hub approval-audit [--last N] [--today] [--request-id ID]` — 查审批审计

## 动作

- `fh hub send <channel> <to> <text>` — 手动发消息（如 `fh hub send wechat <sender_id>@im.wechat "你好"`）；`to` 也可以用昵称，Hub 自动从 allowlist 查 ID
- `fh hub summary <text>` — 设置当前实例的工作描述（在 `fh hub peers` 里显示）
- `fh hub name <id> <name>` — 给实例起名（@路由用，多实例场景）
- `fh hub listen` — 查看当前实例订阅的通道
- `fh hub listen [@TAG] <channels...>` — 设置通道订阅。短名：`wx`=微信 / `tg`=Telegram / `im`=iMessage / `fs`=飞书 / `all`=全部。`@TAG` 可选，指定给哪个实例。用户说"关掉微信"就跑这个命令去掉 `wx`
- `fh hub resolve <request_id>` — 手动清除一条 stale pending 审批（本地 resolved 但 Hub 没收到 cancel 时用）

## 授权

- `fh hub allow <channel> <id> <nickname>` — 授权联系人（需 Touch ID / prompt 验证）。如 `fh hub allow wechat <sender_id>@im.wechat 用户`
- `fh hub revoke <channel> <id|nickname>` — 撤销授权（需 Touch ID / prompt 验证）
- `fh hub owner <channel> [id|nickname|--clear]` — 查看、设置或清除远程审批 owner；审批回复只认 owner

## 紧急锁定（panic button）

- `fh hub lock` — 紧急锁定，立即冻结所有远程通道（出站 / 入站都拦）
- `fh hub unlock` — 解锁
- `fh hub set-lock-phrase <暗号>` — 设置锁定暗号（任意通道收到完全匹配的文字 → 自动触发 lock）

> [!IMPORTANT]
> **绝不跑 `fh hub lock-phrase`**（无参数版）——它会打印出用户的秘密暗号到 terminal。这是用户的秘密功能，暗号不经过 agent 上下文。

## 通道预设

- `fh hub preset list` — 查看已保存的通道预设
- `fh hub preset add <name> <ch:N>...` — 新增预设（如 `fh hub preset add 日常 wx:100 tg:50`，`wx:100` 表示订阅 wx 并回放 100 条历史）
- `fh hub preset remove <name>` — 删除预设

## 发消息用昵称

`fh hub send wechat 用户 "你好"` — Hub 自动从 allowlist 查找昵称对应的 ID，不用记原生 ID。
