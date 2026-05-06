/**
 * Token 预算追踪器。
 *
 * 被动追踪 token 使用量，供 harness 的循环控制和日志使用。
 * 不再直接控制循环继续/停止（已移除 <status> 自动续行机制）。
 */

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
  totalBudget: 500000,
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
