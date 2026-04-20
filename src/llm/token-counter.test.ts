import { describe, it, expect, beforeEach } from 'vitest';
import { TokenCounter } from './token-counter.js';
import type { TokenUsage } from './types.js';

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
      counter.record({ inputTokens: 200, outputTokens: 80, totalTokens: 280, provider: 'anthropic' });

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
      counter.record({ inputTokens: 50, outputTokens: 30, totalTokens: 80, provider: 'anthropic' });

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

      const anthropicStats = cumulative.find(s => s.provider === 'anthropic');
      expect(anthropicStats).toEqual({
        provider: 'anthropic',
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
      counter.record({ inputTokens: 200, outputTokens: 80, totalTokens: 280, provider: 'anthropic' });

      expect(counter.getTotalTokens()).toBe(430);
    });
  });

  describe('reset()', () => {
    it('should clear all recorded data', () => {
      counter.record({ inputTokens: 100, outputTokens: 50, totalTokens: 150, provider: 'openai' });
      counter.record({ inputTokens: 200, outputTokens: 80, totalTokens: 280, provider: 'anthropic' });

      counter.reset();

      expect(counter.getStats()).toEqual([]);
      expect(counter.getTotalTokens()).toBe(0);
      expect(counter.getCumulativeStats()).toEqual([]);
    });
  });
});
