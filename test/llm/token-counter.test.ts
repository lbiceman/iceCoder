import { describe, it, expect, beforeEach } from 'vitest';
import { TokenCounter } from '../../src/llm/token-counter.js';
import type { TokenUsage } from '../../src/llm/types.js';

describe('TokenCounter', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
  });

  describe('record()', () => {
    it('should record a token usage entry', () => {
      const usage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        provider: 'openai',
      };

      counter.record(usage);

      const stats = counter.getStats();
      expect(stats).toHaveLength(1);
      expect(stats[0]).toEqual(usage);
    });

    it('should record multiple token usage entries', () => {
      counter.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150, provider: 'openai' });
      counter.record({ inputTokens: 200, outputTokens: 80, totalTokens: 280, provider: 'deepseek' });

      const stats = counter.getStats();
      expect(stats).toHaveLength(2);
    });

    it('should store a copy of the usage data', () => {
      const usage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        provider: 'openai',
      };

      counter.record(usage);
      usage.inputTokens = 999;

      const stats = counter.getStats();
      expect(stats[0].inputTokens).toBe(100);
    });
  });

  describe('getStats()', () => {
    it('should return an empty array when no records exist', () => {
      expect(counter.getStats()).toEqual([]);
    });

    it('should return a copy of the records array', () => {
      counter.record({ inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'openai' });

      const stats = counter.getStats();
      stats.push({ inputTokens: 0, outputTokens: 0, totalTokens: 0, provider: 'fake' });

      expect(counter.getStats()).toHaveLength(1);
    });
  });

  describe('getCumulativeStats()', () => {
    it('should return empty array when no records exist', () => {
      expect(counter.getCumulativeStats()).toEqual([]);
    });

    it('should aggregate stats by provider', () => {
      counter.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150, provider: 'openai' });
      counter.record({ inputTokens: 200, outputTokens: 80, totalTokens: 280, provider: 'openai' });
      counter.record({ inputTokens: 50, outputTokens: 30, totalTokens: 80, provider: 'deepseek' });

      const cumulative = counter.getCumulativeStats();
      expect(cumulative).toHaveLength(2);

      const openaiStats = cumulative.find(s => s.provider === 'openai');
      expect(openaiStats).toEqual({
        provider: 'openai',
        totalInputTokens: 300,
        totalOutputTokens: 130,
        totalTokens: 430,
        callCount: 2,
      });

      const deepseekStats = cumulative.find(s => s.provider === 'deepseek');
      expect(deepseekStats).toEqual({
        provider: 'deepseek',
        totalInputTokens: 50,
        totalOutputTokens: 30,
        totalTokens: 80,
        callCount: 1,
      });
    });
  });

  describe('getTotalTokens()', () => {
    it('should return 0 when no records exist', () => {
      expect(counter.getTotalTokens()).toBe(0);
    });

    it('should return the sum of all totalTokens across all records', () => {
      counter.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150, provider: 'openai' });
      counter.record({ inputTokens: 200, outputTokens: 80, totalTokens: 280, provider: 'deepseek' });

      expect(counter.getTotalTokens()).toBe(430);
    });
  });

  describe('reset()', () => {
    it('should clear all recorded data', () => {
      counter.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150, provider: 'openai' });
      counter.record({ inputTokens: 200, outputTokens: 80, totalTokens: 280, provider: 'deepseek' });

      counter.reset();

      expect(counter.getStats()).toEqual([]);
      expect(counter.getTotalTokens()).toBe(0);
      expect(counter.getCumulativeStats()).toEqual([]);
    });
  });

  // P2-19: 明细有上限防止无界增长，但累计统计基于独立聚合不受丢弃影响
  describe('明细上限与累计聚合（P2-19）', () => {
    it('明细条数不超过 maxRecords，丢弃最旧的', () => {
      const capped = new TokenCounter(3);
      for (let i = 1; i <= 10; i++) {
        capped.record({ inputTokens: i, outputTokens: 0, totalTokens: i, provider: 'openai' });
      }
      const stats = capped.getStats();
      expect(stats).toHaveLength(3);
      // 仅保留最近 3 条（i=8,9,10）
      expect(stats.map((s) => s.inputTokens)).toEqual([8, 9, 10]);
    });

    it('即使明细被丢弃，getTotalTokens / getCumulativeStats 仍统计全量', () => {
      const capped = new TokenCounter(3);
      for (let i = 1; i <= 10; i++) {
        capped.record({ inputTokens: i, outputTokens: 1, totalTokens: i + 1, provider: 'openai' });
      }
      // 全量 total = Σ(i+1), i=1..10 = (55) + 10 = 65
      expect(capped.getTotalTokens()).toBe(65);
      const cum = capped.getCumulativeStats();
      expect(cum).toHaveLength(1);
      expect(cum[0]).toEqual({
        provider: 'openai',
        totalInputTokens: 55,
        totalOutputTokens: 10,
        totalTokens: 65,
        callCount: 10,
      });
    });
  });
});
