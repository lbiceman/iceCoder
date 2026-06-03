import { describe, it, expect } from 'vitest';
import { LoopController } from '../../src/harness/loop-controller.js';

describe('LoopController.resetForNewRun', () => {
  it('归零轮次与累计 token/工具计数，并重置 startTime', () => {
    const lc = new LoopController({ maxRounds: 10 });
    lc.advanceRound();
    lc.advanceRound();
    lc.recordTokenUsage(100, 50);
    lc.recordToolCalls(3);

    const before = lc.getState();
    expect(before.currentRound).toBe(2);
    expect(before.totalInputTokens).toBe(100);
    expect(before.totalOutputTokens).toBe(50);
    expect(before.totalToolCalls).toBe(3);

    lc.resetForNewRun();
    const after = lc.getState();
    expect(after.currentRound).toBe(0);
    expect(after.totalInputTokens).toBe(0);
    expect(after.totalOutputTokens).toBe(0);
    expect(after.lastInputTokens).toBe(0);
    expect(after.lastOutputTokens).toBe(0);
    expect(after.totalToolCalls).toBe(0);
    expect(after.startTime).toBeGreaterThanOrEqual(before.startTime);
  });
});
