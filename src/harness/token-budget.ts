/**
 * Token 预算追踪器。
 *
 * 被动记下 token 用量。单次 run 真正停不停，看 LoopController 的成本护栏
 * （`DEFAULT_HARNESS_RUN_TOKEN_BUDGET`，1e9），不看这里的 50 万默认值。
 * 50 万只在调用方没传入 totalBudget 时，给本追踪器的剩余比例和摘要用。
 */

/** 未传入 totalBudget 时的追踪器本地默认。不是单次 run 的成本护栏。 */
export const DEFAULT_TOKEN_TRACKER_BUDGET = 500_000;

/**
 * Token 预算配置。
 */
export interface TokenBudgetConfig {
  /** 总 token 预算（输入 + 输出） */
  totalBudget: number;
  /** 当剩余预算低于此比例时，不允许继续（0-1） */
  continuationThreshold: number;
  /** 最大继续次数（防止无限循环） */
  maxContinuations: number;
}

const DEFAULT_CONFIG: TokenBudgetConfig = {
  totalBudget: DEFAULT_TOKEN_TRACKER_BUDGET,
  continuationThreshold: 0.3,
  maxContinuations: 5,
};

/**
 * Token 预算追踪器。
 */
export class TokenBudgetTracker {
  private config: TokenBudgetConfig;
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;
  private continuationCount: number = 0;

  constructor(config?: Partial<TokenBudgetConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 记录 token 使用。
   */
  recordUsage(inputTokens: number, outputTokens: number): void {
    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
  }

  /**
   * 获取已使用的总 token 数。
   */
  getTotalUsed(): number {
    return this.totalInputTokens + this.totalOutputTokens;
  }

  /**
   * 获取剩余 token 预算。
   */
  getRemaining(): number {
    return Math.max(0, this.config.totalBudget - this.getTotalUsed());
  }

  /**
   * 返回当前 tracker 的上限。
   * Harness 传入的是 run 成本护栏；没传时才是 {@link DEFAULT_TOKEN_TRACKER_BUDGET}。
   */
  getTotalBudget(): number {
    return this.config.totalBudget;
  }

  /**
   * 检查预算是否允许继续。
   *
   * 条件：
   * 1. 剩余预算超过阈值
   * 2. 继续次数未超过上限
   */
  shouldContinue(): boolean {
    if (this.continuationCount >= this.config.maxContinuations) {
      return false;
    }

    const remainingRatio = this.getRemaining() / this.config.totalBudget;
    return remainingRatio > this.config.continuationThreshold;
  }

  /**
   * 记录一次继续（由 harness 在确认继续后调用）。
   */
  recordContinuation(): void {
    this.continuationCount++;
  }

  /**
   * 获取当前状态摘要。
   */
  getSummary(): string {
    return `token 预算: ${this.getTotalUsed()}/${this.config.totalBudget} (继续次数: ${this.continuationCount}/${this.config.maxContinuations})`;
  }
}
