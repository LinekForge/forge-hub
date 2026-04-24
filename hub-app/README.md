# Forge Hub Native Client *(preview)*

macOS 原生客户端——把 Dashboard UI 和会话管理合为一体。

Swift shell（文件系统访问 + 终端控制）+ WKWebView（Dashboard React UI）+ JavaScript Bridge 连接两层。

## 编译

```bash
cd hub-app
./build.sh
```

需要：macOS 13+、Xcode Command Line Tools（提供 `swiftc`）、Bun（编译 dashboard）。

产物：`Forge Hub.app`，双击启动。

## 启动模式

| 模式 | 命令 | 说明 |
|------|------|------|
| 默认 | 双击 `Forge Hub.app` | 加载内嵌的 dashboard dist，不需要 dev server |
| 开发 | `Forge Hub.app/Contents/MacOS/ForgeHub --dev` | 连 `localhost:5173`（Vite HMR） |

## 功能

- **联系人列表**：按 CC 会话（jsonl）组织，和 [forge-launcher](https://github.com/LinekForge/forge-launcher) 一致
- **多源聊天**：每个会话可切换查看 jsonl 对话 / 微信 / Telegram / 飞书 / iMessage / Homeland
- **右键菜单**：描述 / 标签 / 置顶 / 通道恢复（带通道配置对话框）/ 聚焦终端 / 复制 Session ID
- **文件发送**：回形针按钮打开系统文件选择器
- **拼音搜索**：中文会话名支持拼音匹配
- **审批**：审批卡片内嵌聊天流（和 Dashboard 一致）
- **运维模式**：实例表 / 通道表 / KPI

## 和 Dashboard 的关系

Dashboard（`hub-dashboard/`）是 React web app，浏览器打开 `localhost:5173` 或 `localhost:9900` 即用。

Native Client 把同一套 Dashboard UI 嵌入 WKWebView，加上 Swift 层的会话扫描、终端控制、文件系统访问。`isNativeApp()` 检测运行环境——浏览器里走 Hub API，WKWebView 里走 native bridge。一套代码，两种运行方式。

## 从 forge-launcher 复用的代码

SessionScanner / SessionStore / SessionDescriptionStore / TerminalAdapter / HubClient / Models（共 ~920 行 Swift）从 [forge-launcher](https://github.com/LinekForge/forge-launcher) OSS 版复制，只改了 log subsystem 字符串。
