/**
 * 通道自愈状态机
 *
 * 三个状态：HEALTHY → RECOVERING → DORMANT
 * 详见设计文档（2026-04-26 凡 × Forge 讨论定稿）
 */

export type HealthState = "healthy" | "recovering" | "dormant";

export interface ChannelHealthConfig {
  name: string;
  baseRetryMs?: number;       // 第一层起始间隔，默认 2000
  maxRetryMs?: number;        // 第一层上限，默认 30000
  retryFactor?: number;       // 退避因子，默认 2
  jitter?: number;            // ±比例，默认 0.2
  restartAfterMs?: number;    // 第一次重启触发阈值，默认 300000 (5min)
  maxRestarts?: number;       // 最大完整重启次数，默认 3
  dormantProbeMs?: number;    // 安静探活间隔，默认 30000
  dormantCooldownMs?: number; // 唤醒重启冷却，默认 300000 (5min)
  onRestart: () => Promise<void>;
  log: (msg: string) => void;
}

const RESTART_THRESHOLDS = [5 * 60_000, 10 * 60_000, 20 * 60_000];

export class ChannelHealth {
  readonly name: string;
  private state: HealthState = "healthy";
  private retryMs: number;
  private failingSinceMs = 0;
  private restartCount = 0;
  /** @internal used for diagnostics/logging */
  lastRestartAttemptMs = 0;
  private lastWakeupAttemptMs = 0;
  private config: Required<ChannelHealthConfig>;

  constructor(config: ChannelHealthConfig) {
    this.name = config.name;
    this.config = {
      baseRetryMs: 2000,
      maxRetryMs: 30_000,
      retryFactor: 2,
      jitter: 0.2,
      restartAfterMs: 5 * 60_000,
      maxRestarts: 3,
      dormantProbeMs: 30_000,
      dormantCooldownMs: 5 * 60_000,
      ...config,
    };
    this.retryMs = this.config.baseRetryMs;
  }

  getState(): HealthState { return this.state; }

  getRetryMs(): number { return this.retryMs; }

  getRestartCount(): number { return this.restartCount; }

  /** 轮询/连接成功时调用。无论什么状态，立刻回到 HEALTHY，全部归零。 */
  onSuccess(): void {
    if (this.state !== "healthy") {
      const downSec = this.failingSinceMs
        ? Math.round((Date.now() - this.failingSinceMs) / 1000)
        : 0;
      this.config.log(
        `[${this.name}] ✅ RECOVERING/DORMANT → HEALTHY` +
        `（断连 ${downSec}s，重启 ${this.restartCount} 次）`,
      );
    }
    this.state = "healthy";
    this.retryMs = this.config.baseRetryMs;
    this.failingSinceMs = 0;
    this.restartCount = 0;
    this.lastRestartAttemptMs = 0;
    this.lastWakeupAttemptMs = 0;
  }

  /**
   * 轮询/连接失败时调用。返回下一次重试前应等待的毫秒数。
   * 如果需要完整重启，会自动调用 onRestart。
   */
  async onFailure(): Promise<number> {
    const now = Date.now();

    if (this.state === "healthy") {
      this.state = "recovering";
      this.failingSinceMs = now;
      this.retryMs = this.config.baseRetryMs;
      this.config.log(`[${this.name}] HEALTHY → RECOVERING`);
    }

    if (this.state === "recovering") {
      const failingDuration = now - this.failingSinceMs;
      const threshold = this.restartCount < RESTART_THRESHOLDS.length
        ? RESTART_THRESHOLDS[this.restartCount]
        : Infinity;

      if (failingDuration >= threshold && this.restartCount < this.config.maxRestarts) {
        this.restartCount++;
        this.lastRestartAttemptMs = now;
        this.config.log(
          `[${this.name}] 完整重启 #${this.restartCount}/${this.config.maxRestarts}` +
          `（已断连 ${Math.round(failingDuration / 1000)}s）`,
        );
        try {
          await this.config.onRestart();
        } catch (err) {
          this.config.log(`[${this.name}] 重启失败: ${String(err)}`);
        }
        this.retryMs = this.config.baseRetryMs;
        this.failingSinceMs = now;
        return this.jitteredDelay();
      }

      if (this.restartCount >= this.config.maxRestarts) {
        this.state = "dormant";
        this.config.log(
          `[${this.name}] RECOVERING → DORMANT` +
          `（${this.config.maxRestarts} 次重启均未恢复，进入安静探活）`,
        );
        return this.config.dormantProbeMs;
      }

      const delay = this.jitteredDelay();
      this.retryMs = Math.min(this.retryMs * this.config.retryFactor, this.config.maxRetryMs);
      return delay;
    }

    // dormant: fixed interval probe
    return this.config.dormantProbeMs;
  }

  /**
   * 出站请求时调用。如果通道在 DORMANT 且冷却期已过，触发唤醒重启。
   * 返回 true 表示通道可能可用（HEALTHY/RECOVERING 或刚唤醒），false 表示冷却期内直接放弃。
   */
  async onOutboundRequest(): Promise<boolean> {
    if (this.state !== "dormant") return true;

    const now = Date.now();
    if (now - this.lastWakeupAttemptMs < this.config.dormantCooldownMs) {
      return false;
    }

    this.lastWakeupAttemptMs = now;
    this.config.log(`[${this.name}] DORMANT 唤醒：收到出站请求，尝试重启`);
    try {
      await this.config.onRestart();
    } catch (err) {
      this.config.log(`[${this.name}] 唤醒重启失败: ${String(err)}`);
      return false;
    }
    return true;
  }

  /** 是否应该继续轮询（DORMANT 也继续，只是间隔不同） */
  shouldContinue(): boolean {
    return true;
  }

  /** 是否处于 DORMANT（供日志降级判断） */
  isDormant(): boolean {
    return this.state === "dormant";
  }

  private jitteredDelay(): number {
    const j = this.config.jitter;
    const factor = 1 + (Math.random() * 2 - 1) * j;
    return Math.round(this.retryMs * factor);
  }
}
