/**
 * Token 预算追踪器。
 *
 * 当模型认为任务完成但 token 预算还有剩余时，
 * 可以注入 nudge 消息让模型继续工作。
 *
 * 这在长任务中很有用：模型可能因为上下文压力
 * 而过早停止，token 预算追踪器可以鼓励它继续。
 */

/**
 * Token 预算配置。
 */
export interface TokenBudgetConfig {
  /** 总 token 预算（输入 + 输出） */
  totalBudget: number;
  /** 当剩余预算超过此比例时，注入继续提示（0-1） */
  continuationThreshold: number;
  /** 最大继续次数（防止无限循环） */
  maxContinuations: number;
  /** 继续提示消息 */
  continuationMessage: string;
}

const DEFAULT_CONFIG: TokenBudgetConfig = {
  totalBudget: 500000,
  continuationThreshold: 0.3,
  maxContinuations: 3,
  continuationMessage: '你还有剩余的 token 预算。如果任务尚未完全完成，请继续工作。如果已经完成，请给出最终总结。',
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
   * 检查是否应该注入继续提示。
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
   * 获取继续提示消息并递增计数。
   */
  getContinuationMessage(): string {
    this.continuationCount++;
    const remaining = this.getRemaining();
    const used = this.getTotalUsed();
    return `${this.config.continuationMessage}\n\n[token 使用情况: 已用 ${used}, 剩余 ${remaining}]`;
  }

  /**
   * 获取当前状态摘要。
   */
  getSummary(): string {
    return `token 预算: ${this.getTotalUsed()}/${this.config.totalBudget} (继续次数: ${this.continuationCount}/${this.config.maxContinuations})`;
  }
}
