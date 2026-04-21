/**
 * Token 计数器 - 跟踪 LLM 调用的 token 使用情况。
 * 记录每次调用的输入 token、输出 token、总 token 和提供者名称。
 * 提供累计使用统计。
 *
 * Requirements: 19.9
 */

import type { TokenUsage } from './types.js';

/**
 * 按提供者分组的累计 token 使用统计。
 */
export interface CumulativeStats {
  provider: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  callCount: number;
}

/**
 * TokenCounter 类，维护 LLM 调用的 token 使用记录。
 */
export class TokenCounter {
  private records: TokenUsage[] = [];

  /**
   * 记录一次 LLM 调用的 token 使用条目。
   */
  record(usage: TokenUsage): void {
    this.records.push({ ...usage });
  }

  /**
   * 获取所有记录的 token 使用条目。
   */
  getStats(): TokenUsage[] {
    return [...this.records];
  }

  /**
   * 获取按提供者分组的累计 token 使用统计。
   */
  getCumulativeStats(): CumulativeStats[] {
    const statsMap = new Map<string, CumulativeStats>();

    for (const record of this.records) {
      const existing = statsMap.get(record.provider);
      if (existing) {
        existing.totalInputTokens += record.inputTokens;
        existing.totalOutputTokens += record.outputTokens;
        existing.totalTokens += record.totalTokens;
        existing.callCount += 1;
      } else {
        statsMap.set(record.provider, {
          provider: record.provider,
          totalInputTokens: record.inputTokens,
          totalOutputTokens: record.outputTokens,
          totalTokens: record.totalTokens,
          callCount: 1,
        });
      }
    }

    return Array.from(statsMap.values());
  }

  /**
   * 获取所有提供者和调用的总 token 数。
   */
  getTotalTokens(): number {
    return this.records.reduce((sum, record) => sum + record.totalTokens, 0);
  }

  /**
   * 清除所有记录的 token 使用数据。
   */
  reset(): void {
    this.records = [];
  }
}
