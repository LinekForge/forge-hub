# Security Policy

## 报告漏洞

发现安全问题请**不要**直接 PR 或 public issue。

**唯一报告渠道**：GitHub Security Advisory—— 到 [https://github.com/LinekForge/forge-hub/security/advisories/new](https://github.com/LinekForge/forge-hub/security/advisories/new) 提交 private advisory。

我们尽量在 7 天内回复，30 天内提供 fix 或缓解方案。

如果 GitHub 不可用（极端场景），请在 repo 的 issue 里开一个**不含具体漏洞细节**的 placeholder（例如："security concern, please contact me"）并留联系方式，maintainer 会主动联络。**不要**把漏洞细节发在 public issue 里。

## 安全模型

Forge Hub **本机进程**（绑 `127.0.0.1`）。所有消息和凭证都在本地文件系统。

### 默认信任边界

- **同机用户都是信任的**：默认 `HUB_API_TOKEN` 不开 → 任何本机进程能 POST `/permission-request` 等。
  - 单用户 Mac 场景 OK；多用户 / 容器 / 共享主机场景**必须**设 `HUB_API_TOKEN` 启用 Bearer 鉴权。
- **来自外部通道的消息默认不信任**：必须通过 allowlist。allowlist 不在 → 消息被 channel 层 + Hub 层第二道防线双重拒绝。

### 已知风险

- **Allowlist 完整性靠文件权限**：`fh hub allow` 写入时强制 `chmod 600`，hub 启动 audit 发现 group/other 可读的自动降权。任何能绕过 FS 权限的进程依然能改。
- **HTTP API 默认不验（`HUB_API_TOKEN` 未设）**：本机 only 场景下`/send*`、`/pending`、`/history`、`/instances`、`/channels` 等端点对同机任意进程/sandboxed app 可读——包括完整聊天历史和 pending 审批 id。单用户 Mac 风险低，多用户 / 容器 / 共享主机**必须**设 token。设了 token 后，除 `/status`（健康检查）之外所有端点都要 Bearer header / `?token=`（WebSocket）。
- **Channel 协议是 prompt injection 面**：所有入站消息都被包装成 `<channel>` tag 给 LLM 看。Hub 用 `formatUnauthorizedNotice` 加抗 injection 包装。但定制 channel plugin 时**务必**验证 sender。
- **launchd 进程信任 PATH 配置**：plist 里 PATH 应该精确指向 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`，避免 PATH hijack。
- **rate-limit 依赖 instance ID 真实性**：`/permission-request` 的 rate limit 按 `body.instance` 分桶。**未设 `HUB_API_TOKEN` 场景下**，同机进程可伪造不同 instance ID 绕过 per-instance 限流，向用户手机刷任意多条审批推送。这不是 bug，是"同机进程都是信任的"本机信任模型的直接推论——`HUB_API_TOKEN` 开启后 WS upgrade 需 `?token=`，伪造 instance 会被 auth 挡。多用户 / 共享主机场景**必须**设 token。

### 防护措施

- **Allowlist 改动需二次确认**：default `FORGE_HUB_AUTH_MODE=prompt`（终端 y/n，零依赖）；`=touchid` 启用 Touch ID（需自行装 `touchid-verify` binary）；`=none` 跳过（不推荐）。见 `fh hub allow / revoke`
- **审批用一次性 nonce**（5 字符 `[a-km-z]`，不可猜）
- **Lock / unlock 写 audit 失败 → 拒操作**（fail-closed：`setLocked`/`setUnlocked` 在 audit 写入失败时 throw，调用链 abort）。`fh hub allow/revoke` 也有 fail-closed：audit 写入失败时 `die()`——但 allowlist 文件在 audit 之前落盘，若 audit 失败，allowlist 改动已持久化（操作实际完成但无审计记录，CLI 返错让用户警觉。完整原子性需 v0.3 WAL/rollback）。其他路径（`/permission-request` 审批事件等）audit 失败仅 logError，不阻塞主流程
- **Lock-phrase（panic button）**—— 任何通道收到完全匹配暗号 → hub 立即冻结

## 升级 / Patch

订阅 [GitHub Releases](https://github.com/LinekForge/forge-hub/releases)。安全 fix 会在 release notes 里标 `[security]`。
