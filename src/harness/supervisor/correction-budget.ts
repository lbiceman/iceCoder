import type { CorrectionBudgetConfig } from '../../types/supervisor.js';

/**
 * §2.6 I4 / §15.5 — free 段 C 类 inject **次数**预算。
 *
 * 与 `RecoveryBoundary` 的分工（P0-2 收口）：
 *   - **RecoveryBoundary**：phase × source × kind 硬规则 + 输出 `budgetCountable`；
 *   - **本类**：仅在被 boundary 标记为 `budgetCountable=true` 时由 `MessageCorrectionPort` 调用
 *     `tryConsume()` 扣减一次；不再重复判定 phase/source/kind。
 *
 * 注：本类只跟踪「次数」，不感知具体文案；上层 port 负责把丢弃信号上报给 EventTimeline。
 */
export interface CorrectionBudgetUsage {
  used: number;
  max: number;
  /** 累计被预算拒绝的 inject 次数，便于回归与 telemetry。 */
  rejected: number;
}

export class CorrectionBudgetTracker {
  private readonly maxPerTask: number;
  private used: number;
  private rejected = 0;

  constructor(config: CorrectionBudgetConfig, initialUsed = 0) {
    this.maxPerTask = Math.max(0, config.freeSegmentMaxPerTask);
    this.used = Math.max(0, initialUsed);
  }

  /**
   * 消费一个预算单位（调用方须已由 RecoveryBoundary 判定 `budgetCountable=true`）。
   * 返回 true 表示允许 inject；false 表示已超限，调用方应丢弃。
   */
  tryConsume(): boolean {
    if (this.used >= this.maxPerTask) {
      this.rejected += 1;
      return false;
    }
    this.used += 1;
    return true;
  }

  /** 当前预算用量；用于持久化 / 测试断言。 */
  snapshot(): CorrectionBudgetUsage {
    return { used: this.used, max: this.maxPerTask, rejected: this.rejected };
  }

  /** 恢复 checkpoint：把磁盘上的 used 推回，避免重启绕过上限。 */
  restoreUsed(used: number): void {
    this.used = Math.max(0, used);
  }

  /** 新任务起始：清零计数。 */
  reset(): void {
    this.used = 0;
    this.rejected = 0;
  }

  /** 当前剩余可用次数；负值统一记 0。 */
  remaining(): number {
    return Math.max(0, this.maxPerTask - this.used);
  }
}

export function createCorrectionBudgetTracker(
  config: CorrectionBudgetConfig,
  initialUsed = 0,
): CorrectionBudgetTracker {
  return new CorrectionBudgetTracker(config, initialUsed);
}
