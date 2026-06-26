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

/** 明细记录的最大保留条数（防止长会话无界增长）。超出后丢弃最旧的明细。 */
export const DEFAULT_MAX_TOKEN_RECORDS = 2000;

/**
 * TokenCounter 类，维护 LLM 调用的 token 使用记录。
 *
 * 内存安全：明细 `records` 仅保留最近 N 条（环形丢弃最旧），但累计统计
 * （getCumulativeStats / getTotalTokens）由独立的运行聚合维护，**不会**因明细
 * 被丢弃而失真——长会话下既不无界增长，累计数字也始终正确。
 */
export class TokenCounter {
  private records: TokenUsage[] = [];
  private readonly maxRecords: number;
  /** 运行聚合：按 provider 累计，独立于 records，避免丢弃明细后统计失真 */
  private cumulative = new Map<string, CumulativeStats>();
  private totalTokens = 0;

  constructor(maxRecords: number = DEFAULT_MAX_TOKEN_RECORDS) {
    this.maxRecords = maxRecords > 0 ? maxRecords : DEFAULT_MAX_TOKEN_RECORDS;
  }

  /**
   * 记录一次 LLM 调用的 token 使用条目。
   */
  record(usage: TokenUsage): void {
    this.records.push({ ...usage });
    // 超出上限：丢弃最旧明细（累计统计已独立维护，不受影响）
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }

    const existing = this.cumulative.get(usage.provider);
    if (existing) {
      existing.totalInputTokens += usage.inputTokens;
      existing.totalOutputTokens += usage.outputTokens;
      existing.totalTokens += usage.totalTokens;
      existing.callCount += 1;
    } else {
      this.cumulative.set(usage.provider, {
        provider: usage.provider,
        totalInputTokens: usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        callCount: 1,
      });
    }
    this.totalTokens += usage.totalTokens;
  }

  /**
   * 获取最近保留的 token 使用明细条目（上限 maxRecords 条）。
   */
  getStats(): TokenUsage[] {
    return [...this.records];
  }

  /**
   * 获取按提供者分组的累计 token 使用统计（基于运行聚合，不受明细丢弃影响）。
   */
  getCumulativeStats(): CumulativeStats[] {
    return Array.from(this.cumulative.values()).map((s) => ({ ...s }));
  }

  /**
   * 获取所有提供者和调用的总 token 数（基于运行聚合）。
   */
  getTotalTokens(): number {
    return this.totalTokens;
  }

  /**
   * 清除所有记录的 token 使用数据。
   */
  reset(): void {
    this.records = [];
    this.cumulative.clear();
    this.totalTokens = 0;
  }
}
