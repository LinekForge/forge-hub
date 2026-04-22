/**
 * Forge Engine 类型定义
 */

// ── 配置 ────────────────────────────────────────────────────────────────────

export interface ContactChannel {
  sender_id: string;
  tool: string;
}

export interface ForgeConfig {
  enabled: boolean;
  scan_dir: boolean;
  contacts: Record<string, Record<string, ContactChannel>>;
}

// ── 原始调度条目（配置文件里的格式） ────────────────────────────────────────

export interface RawScheduleEntry {
  /** 触发时间 */
  hour: number;
  minute: number;
  second?: number;
  /** 通知内容模板 */
  template?: string;
  /** 可插拔 handler 名（优先于 template） */
  handler?: string;
  /** notification meta.sender */
  sender?: string;
  /** 模板变量 */
  prompt?: string;
  label?: string;

  // ── 时间规则 ──
  /** 周几触发（0=周日） */
  weekdays?: number[];
  /** 每月几号触发（1-31） */
  days?: number[];
  /** 每年几月触发（1-12） */
  months?: number[];
  /** 有效期开始（YYYY-MM-DD） */
  start_date?: string;
  /** 有效期结束（YYYY-MM-DD） */
  end_date?: string;

  // ── 行为 ──
  /** 一次性任务，触发后自动删除 */
  one_shot?: boolean;
  /** "random" = 展开为随机时间 */
  expand?: "random";
  /** 来源 */
  source?: "manual" | "ai";
  /** 权限等级 */
  permission?: "auto" | "inform" | "confirm" | "strict";

  // ── Random 展开参数 ──
  active_start?: number;
  active_end?: number;
  daily_count?: number;
  min_per_hour?: number;

  /** 来源配置文件名（loadScheduleDir 注入） */
  _origin?: string;
  /** 在来源配置文件里的条目索引（loadScheduleDir 注入） */
  _entry_index?: number;

  /** 任意额外字段，传给 handler */
  [key: string]: unknown;
}

export interface ScheduleFile {
  schedules: RawScheduleEntry[];
}

/** 向后兼容别名 */
export type ScheduleEntry = RawScheduleEntry;

// ── 展开后的具体条目 ────────────────────────────────────────────────────────

export interface ResolvedEntry {
  hour: number;
  minute: number;
  second: number;
  template?: string;
  handler?: string;
  sender: string;
  prompt?: string;
  label?: string;

  // 时间规则（从 raw 提升为一级字段，shouldFire 直接读）
  weekdays?: number[];
  days?: number[];
  months?: number[];
  start_date?: string;
  end_date?: string;
  one_shot?: boolean;

  source: string;
  permission: string;
  /** 来源配置文件名 */
  origin: string;
  /** 原始条目引用 */
  raw: RawScheduleEntry;
}

// ── 可插拔 Handler ──────────────────────────────────────────────────────────

export interface ScheduleHandler {
  name: string;
  buildContent(
    entry: ResolvedEntry,
    timeStr: string,
    config: ForgeConfig,
  ): { content: string; sender: string };
}

// ── 状态管理 ────────────────────────────────────────────────────────────────

export interface StateManager {
  load(module: string): Record<string, unknown>;
  save(module: string, state: Record<string, unknown>): void;
}
