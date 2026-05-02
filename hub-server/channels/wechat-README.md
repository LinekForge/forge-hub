# 微信通道 · 架构说明

## ClawBot 是什么

ClawBot（龙虾插件）是微信官方推出的个人 AI 助手插件。用户在微信中添加 ClawBot 后，微信联系人列表里会出现一个名为 **"微信ClawBot"** 的专属联系人。

**ClawBot 不是微信号托管方案。** 它不能：
- 接收好友私聊消息
- 代替你给好友发消息
- 访问你的聊天记录或通讯录

它能做的只有一件事：**在你和"微信ClawBot"这个联系人之间提供一个可编程的对话窗口。**

## iLink 协议

iLink（智联）是 ClawBot 的底层 API 协议，由微信官方提供，base URL 为 `https://ilinkai.weixin.qq.com`。

### 扫码登录

用户通过 ClawBot 提供的二维码扫码，将自己的微信号与一个 Bot Token 绑定。扫码后，开发者获得一个 `token`，用于后续的 API 调用。

### 收消息：getupdates

`POST ilink/bot/getupdates` — 长轮询（35 秒 hold）。

当**扫码用户自己**在微信的 ClawBot 对话窗口里发消息时，API 返回该消息。

```
用户在微信 ClawBot 窗口输入 "你好"
  → iLink 服务器
    → getupdates 返回 { from_user_id: "用户ID", message_type: 1 (USER), ... }
      → Hub 收到并处理
```

**关键：`from_user_id` 是扫码用户自己。** 不是其他好友，不是群消息，只有扫码用户在 ClawBot 窗口里发的消息。

### 发消息：sendmessage

`POST ilink/bot/sendmessage` — 向用户回复。

```typescript
{
  msg: {
    from_user_id: "",              // 空——Bot 没有 user_id
    to_user_id: "用户ID",          // 发给扫码用户
    message_type: 2,               // MSG_TYPE_BOT
    context_token: "...",          // 路由到正确的对话上下文
    item_list: [{ type: 1, text_item: { text: "你好！" } }]
  }
}
```

消息会出现在用户微信的 **ClawBot 对话窗口** 里，看起来就像 ClawBot 在回复你。还会触发"对方正在输入中"的提示（通过 `sendtyping` 接口）。

### context_token

每条收到的消息都携带 `context_token`，回复时必须带上。它的作用是将 Bot 的回复路由到正确的对话上下文中。Hub 在 `hub.setState("context-tokens", ...)` 中缓存每个用户的最新 token。

## 对话模型

```
┌─────────────┐         ┌──────────────┐         ┌──────────┐
│ 用户的微信    │  ←───→  │  iLink 服务器  │  ←───→  │ Forge Hub │
│ ClawBot 窗口 │         │ (weixin.qq.com)│         │ (本机)    │
└─────────────┘         └──────────────┘         └──────────┘

用户发消息 → getupdates 收到 → Hub 推给 Claude Code 实例
Claude Code 回复 → Hub 调 sendmessage → ClawBot 窗口显示回复
```

**这是一个 1:1 的对话模型：** 一个 Bot Token 对应一个扫码用户，对话只发生在这个用户和 ClawBot 之间。

## 与 Telegram Bot 的区别

| | Telegram Bot | 微信 ClawBot |
|--|--|--|
| Bot 身份 | 独立账号（@xxxbot），任何人可以搜到 | 不是独立账号，绑定在用户的微信里 |
| 谁能发消息 | 任何 TG 用户都可以给 Bot 发消息 | **只有扫码的那个人** |
| 消息入口 | Bot 的对话窗口 | 微信联系人"微信ClawBot" |
| 一个 Token | 对应一个 Bot，服务所有用户 | 对应一个用户，只服务这个人 |

## Hub 微信通道实现

### 文件结构

| 文件 | 职责 |
|------|------|
| `wechat.ts` | 通道插件主体：轮询、消息处理、发送、allowlist |
| `wechat-ilink.ts` | iLink API 封装：getupdates / sendmessage / getconfig / sendtyping |
| `wechat-types.ts` | 类型定义 |
| `wechat-media.ts` | 媒体下载/上传 |

### 凭据

存储在 `~/.forge-hub/state/wechat/account.json`：

```json
{
  "token": "iLink Bot Token（扫码后获得）",
  "baseUrl": "https://ilinkai.weixin.qq.com",
  "accountId": "用户标识"
}
```

### Allowlist

微信通道的 `from_user_id` 始终是扫码用户本人。Allowlist 用于验证 sender_id 是否是主人（防止 token 泄露后被他人使用）。

### 消息去重

iLink 长轮询不保证 exactly-once，`message_id` 用于去重（固定 500 容量 Set，FIFO 淘汰）。

## 跨通道桥接场景

理解了 ClawBot 的对话模型后，跨通道桥接（如 `examples/channel-bridge.ts`）的链路：

```
Alice (TG)                        Hub 主人 (微信 ClawBot 窗口)
   │                                        │
   ├─ 给 TG Bot 发 "明天吃饭吗"              │
   │     → Hub 收到                          │
   │       → bridge 调 /send 走微信通道        │
   │         → ClawBot 窗口显示               │
   │           "【Alice 说：】明天吃饭吗"  ←────┤
   │                                        │
   │                              在 ClawBot 窗口回复 ─┤
   │                              "@Alice 好的几点"    │
   │     ← bridge 转发回 TG                  │
   ├─ TG 收到 "好的几点"                      │
```

**微信侧的一切交互都在 ClawBot 窗口里。** Bridge 不会也不能触达用户的好友私聊。
