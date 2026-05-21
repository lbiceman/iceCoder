import type {
  CorrectionBlock,
  CorrectionBudgetConfig,
  CorrectionSource,
  SupervisorPhase,
} from '../../types/supervisor.js';

/**
 * §2.6 I4 / §15.5 — free 段 C 类 inject 预算。
 *
 * 约束（与规格 §19.6 / 附录 B 对齐）：
 *   - 仅在 `phase === 'free'`、`source === 'supervisor'`、`kind ∈ {'recovery','graph_hint'}` 时计数；
 *     - takeover/handoff_pending/cooldown 段由 RecoverySupervisor / runRecoveryMainPath 控量，
 *       不走 free 段预算；
 *     - shadow_diagnostic 不计入（shadow 段允许诊断累计）；
 *     - lifecycle / memory / compaction 注入由各自负责，不消耗 supervisor 预算。
 *   - 用量达到 `freeSegmentMaxPerTask` 后 `tryConsume` 返回 false；调用方应丢弃该次 inject 并仅写 timeline。
 *   - 任务级计数；`reset()` 用于显式新任务边界（V1 由 Harness 在每次 `run()` 开头复位）。
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
   * 尝试为本次 inject 消费一个预算单位。
   * 返回 true 表示允许 inject；false 表示已超限，调用方应丢弃。
   */
  tryConsume(args: {
    block: CorrectionBlock;
    phase: SupervisorPhase;
    source: CorrectionSource;
  }): boolean {
    if (!this.isCountable(args)) return true;

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

  /**
   * §15.5 `freeSegmentMaxPerTask` 约束的 inject 类别判定。
   * 仅 free 段 supervisor 来源的 recovery / graph_hint 计入；其它一律放行。
   */
  private isCountable(args: {
    block: CorrectionBlock;
    phase: SupervisorPhase;
    source: CorrectionSource;
  }): boolean {
    if (args.source !== 'supervisor') return false;
    if (args.phase !== 'free') return false;
    return args.block.kind === 'recovery' || args.block.kind === 'graph_hint';
  }
}

export function createCorrectionBudgetTracker(
  config: CorrectionBudgetConfig,
  initialUsed = 0,
): CorrectionBudgetTracker {
  return new CorrectionBudgetTracker(config, initialUsed);
}
