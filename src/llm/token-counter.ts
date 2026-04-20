/**
 * Token Counter - tracks token usage across LLM calls.
 * Records input tokens, output tokens, total tokens, and provider name per call.
 * Provides cumulative usage statistics.
 *
 * Requirements: 19.9
 */

import type { TokenUsage } from './types.js';

/**
 * Cumulative token usage statistics per provider.
 */
export interface CumulativeStats {
  provider: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  callCount: number;
}

/**
 * TokenCounter class that maintains a record of token usage across LLM calls.
 */
export class TokenCounter {
  private records: TokenUsage[] = [];

  /**
   * Record a new token usage entry from an LLM call.
   */
  record(usage: TokenUsage): void {
    this.records.push({ ...usage });
  }

  /**
   * Get all recorded token usage entries.
   */
  getStats(): TokenUsage[] {
    return [...this.records];
  }

  /**
   * Get cumulative token usage statistics grouped by provider.
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
   * Get the overall total token count across all providers and calls.
   */
  getTotalTokens(): number {
    return this.records.reduce((sum, record) => sum + record.totalTokens, 0);
  }

  /**
   * Clear all recorded token usage data.
   */
  reset(): void {
    this.records = [];
  }
}
