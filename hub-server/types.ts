/**
 * Forge Hub — 类型定义
 */

// ── Hub 配置 ────────────────────────────────────────────────────────────────

export interface HubConfig {
  port: number;
  host: string;
  primary_instance: string;
  show_instance_tag: boolean;
  /**
   * 远程审批通道列表。Claude Code 发起 permission_request 时，hub 推送到这些通道。
   * 空数组或未配置 = 禁用远程审批（返回 503）。
   */
  approval_channels?: string[];
  /**
   * 推送模式：
   * - "parallel" (default)：并发推送到所有 approval_channels，任一成功即算登记成功
   * - "sequential"：按 approval_channels 顺序尝试，第一个成功就停。适合"优先微信，挂了再 tg"的 fallback 场景
   * 任一模式下只要 ≥1 个通道成功就登记 pending；全失败返 502。用户回复从任一成功通道回都能被识别。
   */
  approval_push_mode?: "parallel" | "sequential";
  /**
   * instance WS ready 时是否自动推送聊天历史到 CC context（default true 保持兼容）。
   * false 时改为 pull-model——由 instance 通过 `hub_replay_history` tool 主动拉，或用户用 `fh hub replay` 触发。
   * 想开"纯净测试窗口"就设 false。
   */
  auto_replay_on_ready?: boolean;
  /**
   * 自动 replay 时每通道推送的条数上限（default 10）。之前硬编码 100——对用户的 CC context 太重。
   * 设成 0 = 不推这个通道（等价于 auto_replay_on_ready: false 对某个通道生效）。
   */
  auto_replay_count?: number;
  /**
   * 每通道 ASR provider 选择覆盖。缺省让 plugin 自己决定（实现了 asrTranscribe
   * 的通道用 plugin 自带，其他走 FORGE_HUB_ASR_HOOK env 指向的用户 hook）。
   * 用户想**强制**改路径时才配这个——比如飞书自带 ASR 但用户想绕开走自己的 hook：
   *   { "feishu": "hook" }
   * 或者完全关某通道 ASR：
   *   { "imessage": "none" }
   * 值：
   *   "hook" = 强制走 FORGE_HUB_ASR_HOOK（即使 plugin 自己实现了 asrTranscribe）
   *   "none" = 关闭 ASR，agent 只拿到 audio path 占位
   */
  asr_plugin_override?: Record<string, "hook" | "none">;
}

// ── 通道插件接口 ────────────────────────────────────────────────────────────

export type ChannelCapability = "text" | "file" | "voice" | "image";

export interface ChannelPlugin {
  /** 插件名，用于路由（如 "wechat"） */
  name: string;
  /** 显示名（如 "微信"）。缺省时 loader 用 `name` fallback */
  displayName?: string;
  /** 短名别名（如 ["wx"]） */
  aliases: string[];
  /** 支持的发送类型。router 在 send-dispatch 时会强制过滤——不在此列表的 type 直接返 `{success:false, error:"unsupported"}`，不给 plugin.send 调用 */
  capabilities: ChannelCapability[];
  /**
   * 启动连接。允许 throw——loader 会 catch 并把该 plugin 标为加载失败（不加入 sendMap）。
   * 比如 telegram 读不到 bot_token、feishu lark-cli 不可用——这些"plugin 不 functional"的情况 throw，
   * 让 Hub 知道此通道是 dead，`/status` 能如实报告。
   */
  start(hub: HubAPI): Promise<void>;
  /** 发送消息到外部 */
  send(params: SendParams): Promise<SendResult>;
  /** 停止连接。loader 用 10s timeout 包住，超时就强行继续关闭其他通道——不要让 stop 卡死拖垮热重载 */
  stop(): Promise<void>;
  /**
   * 判断给定的 `to` 字符串是否已经是本通道的 native recipient ID（而非昵称）。
   * Hub 用此方法决定 /send 时是否需要 allowlist 昵称查找。
   *
   * 实现例：wechat `to.includes("@im.wechat")`，telegram `/^\d{5,}$/.test(to)`。
   *
   * 可选——缺省时 Hub 会 fallback 到 resolve 成 allowlist 失败 → 退回"当 native id"
   * 的宽松路径。实现该方法让新通道无需改 hub.ts 即可参与路由分流（redteam A6）。
   */
  isNativeId?(to: string): boolean;

  /**
   * 插件停止时的原因——hub 层 watchdog 用来判断是否自动 restart。
   *
   * 可重启（watchdog 会 stop+start）：network / conflict / crash / cap_reached
   * 不可重启（需要人改配置）：auth / config
   *
   * 插件在 polling loop break 前写入。未写 = 正常 stop（如 hub shutdown）。
   */
  stoppedReason?: ChannelStopReason;

  /**
   * **可选** ASR hook——通道自带的语音转文字实现。
   *
   * 如果通道的原生 API / SDK 提供 ASR 服务（如飞书 speech_to_text / 未来的其他平台），
   * plugin 可以实现这个 method 把该能力 expose 出来。Hub 入站处理 audio 时会**优先**
   * 调 plugin 自带的 asrTranscribe（除非用户在 hub-config 的 `asr_plugin_override[channel]`
   * 里显式 override 到 "hook" 或 "none"）。
   *
   * 没实现 = Hub fallback 到 `FORGE_HUB_ASR_HOOK` env 指向的用户 hook（如果配了），
   * 再 fallback 到 null（agent 只看到 audio path 占位）。
   *
   * 参数 `audioPath` 是 Hub 已下载到本地的音频文件绝对路径（ogg / caf / mp3 等），
   * plugin 可以直接读 + 调自己的 API。返回识别文本；失败返 null（不抛，错误用 hub.logError）。
   */
  asrTranscribe?(audioPath: string): Promise<string | null>;
}

export type ChannelStopReason = "auth" | "config" | "crash" | "network" | "conflict" | "cap_reached";

/** hub 层 watchdog 判断是否自动 restart 的白名单 */
export const RESTARTABLE_REASONS = new Set<ChannelStopReason>(["network", "conflict", "crash", "cap_reached"]);

export interface HubAPI {
  /** 插件收到消息，推给 Hub */
  pushMessage(msg: InboundMessage): void;
  /**
   * 读取通道状态。
   * 泛型 T 让调用方直接拿到目标类型：`hub.getState<{token:string}>("config")`——
   * 返回 `null` 表示文件不存在或解析失败。
   */
  getState<T = unknown>(key: string): T | null;
  /** 写入通道状态 */
  setState(key: string, value: unknown): void;
  /** 带通道前缀的日志 */
  log(msg: string): void;
  /** 带通道前缀的错误日志 */
  logError(msg: string): void;
  /**
   * 生成"未授权消息尝试"的 system 告警文案（抗 injection 包装）。
   * 签名里**不需要 channel**——`hub` 对象本身是 per-channel factory 产生的，channel name 从 closure 取。
   */
  formatUnauthorizedNotice(displayName: string, senderId: string, rawContent: string): string;
  /**
   * 对音频文件做 ASR 识别。Plugin 入站 audio 下载完后调这个拿识别文本：
   *
   * ```ts
   * const filePath = await downloadTgFile(...);
   * const text = await hub.resolveAsr(filePath);
   * const content = text ? `[语音] ${text}` : `[语音] ${filePath}`;
   * ```
   *
   * Hub 内部决定走 plugin 自带的 asrTranscribe / 用户 hook（`FORGE_HUB_ASR_HOOK`）/
   * 关闭（根据 hub-config.json 的 `asr_plugin_override[channel]`）。channel 参数由 HubAPI
   * factory 按 closure 注入，plugin 不用传。
   *
   * 失败 / 没配置 / 显式设为 "none" 都返 null——plugin 应该 fallback 到给 agent
   * 一个 audio 路径占位（`[语音] ${path}`），让 agent 决策要不要回"能文字告诉我吗"。
   */
  resolveAsr(audioPath: string): Promise<string | null>;
}

// ── 通道 Allowlist（所有通道共享 schema） ──────────────────────────────────

/** 单个授权条目。`id` 是通道原生 sender 标识（如 wechat 的 `xxx@im.wechat`），`nickname` 是人类可读的短名（用于 @路由 / log） */
export interface AllowEntry {
  id: string;
  nickname: string;
}

/** 通道的授权列表。存在 `state/{channel}/allowlist.json`。通道必须统一这个 schema——`isApprovalOwner`（hub.ts）依赖 `allowed[0].id` 找主人 */
export interface Allowlist {
  allowed: AllowEntry[];
  auto_allow_next: boolean;
}

// ── 消息 ────────────────────────────────────────────────────────────────────

/** 入站消息（通道插件 → Hub） */
export interface InboundMessage {
  channel: string;
  from: string;
  fromId: string;
  content: string;
  /** 通道特有数据（context_token 等） */
  raw: Record<string, unknown>;
}

/** 出站发送参数（Hub → 通道插件） */
export interface SendParams {
  to: string;
  content: string;
  type: "text" | "file" | "voice";
  filePath?: string;
  /** 通道特有数据（Hub 自动注入 context_token 等） */
  raw?: Record<string, unknown>;
}

export interface SendResult {
  success: boolean;
  error?: string;
  /**
   * Hub 层对这次发送的风险提示——比如通道 degraded、入站长时间无消息等。
   * plugin 本身不设置（它不知道 health 全局），由 endpoints.ts 根据通道
   * health status 注入到 Response。agent 看到 warning 可以决定换通道重发
   * 或向用户确认。成功 + warning 的组合意味着"发了但风险高"。
   */
  warning?: string;
}

// ── WebSocket 推送（Hub ↔ 实例） ──────────────────────────────────────────────

/** WebSocket upgrade 时附带的连接数据 */
export interface WsData {
  instanceId: string;
}

/** Client → Hub（WebSocket 消息） */
export type WsClientMessage =
  | { type: "ready"; tag?: string; description?: string; channels?: string[]; history?: Record<string, number> };

/** Hub → 实例的实时事件 */
export interface HubEvent {
  type: "message" | "instance_message" | "system" | "permission_response";
  channel: string;
  from: string;
  fromId: string;
  content: string;
  targeted: boolean;
  raw: Record<string, unknown>;
}

// ── 远程审批 ───────────────────────────────────────────────────────────────

/** Claude Code → hub 的审批请求载荷 */
export interface PermissionRequest {
  /** 5 字母小写 ID，不含 'l'。由 Claude Code 生成，必须全局唯一 */
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

/** hub → Claude Code 的审批响应载荷 */
export interface PermissionResponse {
  request_id: string;
  behavior: "allow" | "deny";
}

/** hub 内存里挂起的审批请求 */
export interface PendingPermission {
  /** Claude Code 生成的内部 ID（MCP 协议 request_id），作为 pending map 的 key 和回传给 CC 的标识。不展示给人。 */
  request_id: string;
  /** 展示给用户的"批准 ID"——只能配 `yes` 使用，强绑定 allow 语义 */
  yes_id: string;
  /** 展示给用户的"拒绝 ID"——只能配 `no` 使用，强绑定 deny 语义 */
  no_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
  /** 发起请求的实例 ID，回复要回到它 */
  from_instance: string;
  /** ms epoch，用于 TTL 清理 */
  created_at: number;
  /** 实际成功推送的通道名列表（调试/日志用） */
  pushed_channels: string[];
}

// ── 实例连接 ────────────────────────────────────────────────────────────────

export interface ConnectedInstance {
  id: string;
  /** @路由标签（短，如 P、A） */
  tag?: string;
  /** 描述（长，如 Forge 引擎） */
  description?: string;
  /** 订阅的通道（undefined = 全部，["wechat"] = 只听微信） */
  channels?: string[];
  connectedAt: string;
  summary?: string;
  /** WebSocket 连接引用 */
  ws: import("bun").ServerWebSocket<WsData>;
  /** 发送事件 */
  send(event: HubEvent): void;
  /** 关闭连接 */
  close(): void;
}
