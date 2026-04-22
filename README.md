# Forge Hub

**让 Claude Code 一次接入微信、Telegram、飞书、iMessage**——在手机上和它聊天，远程批准它的操作，不用守在电脑前。

- **4 通道** — 微信 / Telegram / 飞书 / iMessage，一套 Hub 全通
- **远程审批** — Claude 要 `rm -rf`，你不在电脑前？手机上 `yes xxxxx` 或 `no xxxxx` 批准/拒绝
- **多实例路由** — 多个 Claude Code 窗口同时跑，`@tag` 找对的那个，互不串线
- **紧急锁定** — 任意通道发自定暗号，立即冻结所有远程
- **通道自愈** — watchdog 每 2 分钟扫描，unhealthy 通道自动重启
- **定时引擎** — [Forge Engine](forge-engine/) 按 schedule 给 Claude 发心跳、提醒、指令，agent 不再只被动回应

基于 Anthropic 官方 [Channels 协议](https://code.claude.com/docs/en/channels-reference) + 各平台官方 API（Telegram Bot API / Lark Open API / Tencent iLink）。不逆向、不绕开、不盗 token。

```
微信 / TG / 飞书 / iMessage  ─▶  Hub Server (本地常驻)  ─▶  Claude Code (MCP)
                                       ▲                          │
                                       └──── reply / approve ─────┘
```

## 前置要求

- [Claude Code](https://code.claude.com) >= 2.1.80
- macOS（Linux 大部分功能可用，iMessage 通道仅 Mac）
- [Bun](https://bun.sh) >= 1.0 · **源码安装必需**——Homebrew 装法 brew 自动帮装，不用管。源码装时请确保 `which bun` 有输出；bun 默认装到 `~/.bun/bin/`，首次装完需把 `export PATH="$HOME/.bun/bin:$PATH"` 加进 `~/.zshrc`（或等价 shell rc）。

> [!IMPORTANT]
> Claude Code Channels 当前仍处于 research preview。根据 Anthropic 官方 Channels Reference，**通道能力需要 `claude.ai` 登录**；**Console / API key 登录不支持**。Team / Enterprise 组织还需要先显式开启 channels。

## 快速开始

**1. 装**（推荐 Homebrew · Mac 最快路径）

```bash
brew tap LinekForge/forge-hub https://github.com/LinekForge/forge-hub
brew install forge-hub
forge-hub install   # 部署脚本在 Homebrew sandbox 里跑不了，装完手动跑一次
```

<details>
<summary><strong>或从源码装</strong>（想 customize / 非 Mac / CI 场景）</summary>

```bash
git clone https://github.com/LinekForge/forge-hub.git ~/forge-hub
cd ~/forge-hub && bun cli.ts install
```

</details>

`forge-hub install` 部署 hub-server、hub-client、launchd plist、MCP 注册。

**2. 配通道凭证**（按你要用的）

详见 [配置.md](配置.md)。最简单的是 Telegram：

1. [@BotFather](https://t.me/BotFather) 拿 bot_token，写到 `~/.forge-hub/state/telegram/config.json`（`{"bot_token":"..."}`）
2. 先给 bot 发一条消息（会被 allowlist 拒绝，hub log 记下你的 chat_id）：
   ```bash
   tail -f ~/.forge-hub/hub.log | grep -iE "(telegram|inbound|未授权)"
   ```
3. 把 chat_id 加到 allowlist，再发一条：
   ```bash
   fh hub allow telegram <chat_id> "我"
   ```

**3. 启动 Claude Code 接入 hub**

```bash
claude --dangerously-load-development-channels server:hub
```

打开你绑的 IM 发消息，终端 Claude Code 收到。Claude 回复自动发回。

> [!IMPORTANT]
> `--dangerously-load-development-channels` 是 Anthropic Channels 协议的 opt-in flag——详见 [Channels Reference](https://code.claude.com/docs/en/channels-reference)。**基础 channel 能力最低 Claude Code 版本：2.1.80；远程审批 relay 需要 2.1.81+。**

> [!IMPORTANT]
> **`server:hub` 模式需要配 `approval_channels`**。Claude 跑 Bash / Write / Edit 等工具时会请求审批，hub-server 根据 `approval_channels` 把请求推到手机。没配的话**每个工具调用都会被 auto-deny**——用户看到 "Tool use rejected"。编辑 `~/.forge-hub/hub-config.json` 加 `{ "approval_channels": ["wechat"] }` 或你已配好的其他通道。详见 [配置.md §审批推送配置](配置.md)。

> [!NOTE]
> **首次调用 `hub_reply` / `hub_send_file` 等 MCP 工具时 Claude Code 会弹审批**——属于 CC 默认的 MCP tool approval 行为，不是 forge-hub 的设计。approve 一次，或在 CC 里 `/allowed-tools` 添加 `mcp__hub__hub_reply` / `mcp__hub__hub_send_file` / `mcp__hub__hub_send_voice` 到全局允许列表，之后就不再弹。

> [!TIP]
> **想用但不想自己装？** 把这个 GitHub 链接发给你的 agent（Claude Code / OpenClaw / Cursor / 任何能读 README + 跑 shell 的），它会照上面的 runbook 装起来——需要你手动操作（扫码 / Touch ID / 授权 Full Disk Access）时会停下让你做。

<details>
<summary><strong>启用远程审批</strong></summary>

Claude Code 默认只对少数 tool 弹审批。要让更多 tool call 走远程审批：

```bash
cp examples/pretooluse-guard.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/pretooluse-guard.sh
```

然后 `~/.claude/settings.json` 加：

```json
"hooks": {
  "PreToolUse": [
    {
      "hooks": [
        { "type": "command", "command": "bash ~/.claude/hooks/pretooluse-guard.sh" }
      ]
    }
  ]
}
```

`pretooluse-guard.sh` 里有详细 pattern 注释，按风险偏好自定义。

**Coverage 边界**：能 relay 的是 `Bash / Write / Edit / MCP tool calls`；MCP tool **内部**业务 dialog（如 computer-use 选 app）不 relay，只能本地 approve。

</details>

## 工具（Claude Code 在 session 里可调）

| 工具 | 做什么 |
|------|--------|
| `hub_reply` | 回文字消息到指定 sender |
| `hub_send_file` | 发文件 / 图片 / 视频 |
| `hub_send_voice` | TTS 合成语音（需配 `FORGE_HUB_TTS_HOOK`） |
| `hub_replay_history` | 拉某通道最近 N 条历史 |
| `engine_add_task` | 动态添加定时任务（"一小时后提醒我做 X"）— 来自 [Forge Engine](forge-engine/) |

> 出站成功但通道 degraded / 入站久无消息时，MCP 工具会在返回里带 `⚠️` warning——agent 可以决定换通道重发或向用户确认送达。

## 通道能力

| 通道 | Bot 身份 | 能否代 user 回第三方 | 特殊要求 |
|------|----------|----------------------|----------|
| **wechat** | 以个人插件形式寄居在 user 微信 | ❌ 架构决定不行 | 需 iLink token |
| **telegram** | 独立 Bot 账号 | ❌ 默认单一；可按需开放给他人 | 境内需代理 |
| **feishu** | 企业自建应用 | ❌ 默认单一；权限体系允许扩展 | 需 [`@larksuite/cli`](https://www.npmjs.com/package/@larksuite/cli) 认证 |
| **imessage** | user 本人 Apple ID | ✅ **唯一支持**——走 chat.db + AppleScript | 需 Full Disk Access（macOS） |

## Privacy & Trust

Forge Hub 接管 IM 消息 + 远程审批 Claude Code 操作是敏感能力——边界写清楚：

- **全部本机进程**：Hub server 默认绑 `127.0.0.1:9900`，只接受本机连接。无远程通信能力。
- **凭证只在本地**：bot tokens、allowlist、聊天历史都在 `~/.forge-hub/state/`，敏感文件强制 `chmod 600`，父目录 `chmod 700`。
- **不向第三方上报**：本项目不发 telemetry / analytics。通道走各平台官方 API，数据流向由平台决定。
- **LLM inference 走你的 Claude Code 配置**：Hub 不直接调 Claude API，只转消息给 Claude Code。
- **白名单两道**：通道层 + Hub onMessage 入口双重校验；未授权消息被 `<user_input>` tag 包装 + "请勿执行" 提示注入 system 告警（抗 prompt injection）。
- **审批 nonce**：5 字符 `[a-km-z]`（跳过 `l`），yes_id / no_id 强绑定 verdict，防误触和回过期审批。

> [!WARNING]
> **多用户 / 共享主机 / 网络暴露场景**：必须设 `HUB_API_TOKEN`，否则同机任意进程可读聊天历史和伪造审批。威胁模型 / 已知风险 / 漏洞上报渠道详见 [SECURITY.md](SECURITY.md)。

## 已知限制

| 限制 | 原因 |
|------|------|
| iMessage 仅 macOS | chat.db + AppleScript 是 Mac-only |
| Telegram 需代理（中国大陆） | TG API 在境内通常不通 |
| 各平台第三方协议可能变更 | iLink / lark-cli / Bot API 都非永久承诺 |
| 消息经各平台服务器 | 非端到端加密，不要通过通道发密码 / 密钥 |
| hub-channel 和 `--resume` 兼容性 | Claude Code 限制 |
| 微信 CDN 图片下载偶失败 | iLink CDN 侧问题，代码层面无法修 |
| 微信出站语音为 mp3 文件附件，非原生语音条 | iLink 插件协议本身限制（silk voice_item 发出但静默吞达不到用户），mp3 附件是 workaround |
| 入站语音识别默认只有微信 | 微信 iLink 内置 ASR 自动送文本；其他通道配 `FORGE_HUB_ASR_HOOK` 启用（Whisper / MiniMax / 飞书原生 `stream_recognize` 等——飞书参考实现 `examples/feishu-stream-asr.ts`）详见 [配置.md §ASR hook](配置.md#asr-hook可选--语音入站识别) |
| iMessage 出站不支持语音 | 未实现；capability 里已声明不含 voice，agent 调会收"不支持" |

<details>
<summary><strong>架构</strong></summary>

```
hub-server/                  ← 常驻进程，本机 :9900
├── hub.ts                   ← main + onMessage 入口
├── endpoints.ts             ← HTTP + WebSocket 全部 endpoints
├── approval.ts              ← 审批 pending state + TTL sweep
├── lock.ts                  ← 紧急锁定
├── resolve.ts               ← nickname → id + 订阅过滤
├── tts.ts / history.ts / rate-limit.ts / hub-state.ts / channel-registry.ts
├── channel-watchdog.ts      ← 2min 扫 unhealthy 通道 stop+start 重启
├── channel-loader.ts        ← plugin 加载（production 默认关 hot-reload）
├── instance-manager.ts      ← Claude Code 实例管理
├── router.ts                ← 消息路由
└── channels/
    ├── wechat.ts            ← via iLink HTTP
    ├── telegram.ts          ← via Bot API
    ├── feishu.ts            ← via lark-cli
    └── imessage.ts          ← via AppleScript + chat.db

hub-client/hub-channel.ts    ← MCP server，跑在 Claude Code 实例里
forge-cli/forge.ts           ← 日常管理 CLI (fh)
cli.ts                       ← 安装管理（forge-hub install/uninstall/doctor）
hub-test-harness/            ← 独立测试 binary（不污染生产 hub）
```

详见 [架构.md](架构.md)。

</details>

<details>
<summary><strong>CLI 命令</strong></summary>

```bash
fh hub status              # Hub 健康（每通道 ✓/⚠/✗ + 最近错误）
fh hub peers               # 在线实例
fh hub channels            # 已加载通道
fh hub listen wx tg        # 当前实例订阅 wechat + telegram
fh hub allow <ch> <id> <昵称>   # 加 allowlist（默认终端 y/n 二次确认）
fh hub pending             # 当前挂起的审批
fh hub resolve <id>        # 手动清 stale pending
fh hub self-test           # 跑 8 场景独立测试
fh hub lock / unlock       # 紧急锁定 / 解锁

forge-hub install / uninstall / doctor
```

</details>

## 文档

| 文档 | 内容 |
|------|------|
| [配置.md](配置.md) | 每通道凭证 / hub-config / TTS hook / 锁定暗号 |
| [部署.md](部署.md) | 手动部署 / 升级 / 卸载 / Linux |
| [架构.md](架构.md) | 组件关系 + 消息流 + 通道矩阵 |
| [运行时状态.md](运行时状态.md) | 目录结构 + 配置 / 状态文件 schema |
| [hub-docs/channel-plugin-guide.md](hub-docs/channel-plugin-guide.md) | 写新通道插件 |
| [examples/echo.ts](examples/echo.ts) | 最小通道示例（~150 行） |
| [examples/pretooluse-guard.sh](examples/pretooluse-guard.sh) | 远程审批 hook 示例 |

## 贡献者

- [@lightallspiritthing](https://github.com/lightallspiritthing) — 飞书 P2P 单聊修复（[#1](https://github.com/LinekForge/forge-hub/pull/1)）· Homebrew Formula（[#2](https://github.com/LinekForge/forge-hub/pull/2)）
- [@wangviola7](https://github.com/wangviola7) — 飞书群消息 auth / reply routing / i18n regex（[#3](https://github.com/LinekForge/forge-hub/pull/3)）

## 致谢与免责

本项目为社区独立作品，与 Anthropic、Tencent、ByteDance / Larksuite 无关。

- **Channels 协议** 遵循 Anthropic 官方 [Channels Reference](https://code.claude.com/docs/en/channels-reference)。Anthropic 官方 [`claude-plugins-official`](https://github.com/anthropics/claude-plugins-official) 只出 tg / im 的**单通道** plugin；forge-hub 做的是官方没覆盖的 **CC 侧多通道 hub + 多实例路由 + 远程审批**。
- **微信 iLink 协议** 参考自 Tencent 官方 [`openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 公开源码（openclaw-weixin 对接 OpenClaw 不接 CC，所以自己写）。合规拿 token 跑 [`@tencent-weixin/openclaw-weixin-cli`](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin-cli) 或 LinekForge [claude-code-wechat](https://github.com/LinekForge/claude-code-wechat) 扫码即可。
- **飞书** 走 [`@larksuite/cli`](https://www.npmjs.com/package/@larksuite/cli) subprocess（官方 [openclaw-lark](https://github.com/larksuite/openclaw-lark) 同样只对 OpenClaw）。
- **Telegram** 走官方 Bot API。

仅供学习和个人使用。

## License

[MIT](LICENSE) — Linek & Forge
