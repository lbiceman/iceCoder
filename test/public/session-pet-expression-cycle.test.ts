/**
 * 冰豆表情轮播逻辑：每 intervalMs 切换一次 setState。
 * 与 src/public/js/session-pet.js 中 EXPRESSIONS 键一致（不含 blink，blink 由内部眨眼定时器驱动）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** 与 SessionPet 对外表情键一致（不含 blink） */
export const PET_EXPRESSION_CYCLE = [
  'idle',
  'planning',
  'running',
  'executing',
  'streaming',
  'tool_calling',
  'recovering',
  'restoring',
  'cancelling',
  'memory',
  'clap',
  'error',
  'tool_confirm',
  'user_checkpoint',
] as const;

export type PetExpressionId = (typeof PET_EXPRESSION_CYCLE)[number];

describe('PET_EXPRESSION_CYCLE 与绘制函数同步', () => {
  it('对外表情键在 harness 绘制表中存在', async () => {
    const { HARNESS_PET_EXPRESSIONS } = await import('../../src/public/js/session-pet-harness-expr.js');
    for (var i = 0; i < PET_EXPRESSION_CYCLE.length; i++) {
      var id = PET_EXPRESSION_CYCLE[i];
      expect(typeof HARNESS_PET_EXPRESSIONS[id]).toBe('function');
    }
  });
});

/** 立即应用首项，之后每 intervalMs 切下一项；返回 stop 清除定时器 */
export function createPetExpressionCycle(
  setState: (state: string) => void,
  states: readonly string[],
  intervalMs: number,
): { stop: () => void } {
  let idx = 0;
  setState(states[idx]);
  const id = setInterval(function () {
    idx = (idx + 1) % states.length;
    setState(states[idx]);
  }, intervalMs);
  return {
    stop: function () {
      clearInterval(id);
    },
  };
}

describe('session-pet expression cycle (every 5s)', () => {
  beforeEach(function () {
    vi.useFakeTimers();
  });
  afterEach(function () {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('立即设置第一个表情，之后每 5000ms 按序切换并循环', function () {
    const calls: string[] = [];
    const c = createPetExpressionCycle(function (s) {
      calls.push(s);
    }, PET_EXPRESSION_CYCLE, 5000);

    expect(calls).toEqual(['idle']);

    for (let step = 1; step < PET_EXPRESSION_CYCLE.length; step++) {
      vi.advanceTimersByTime(5000);
      expect(calls[calls.length - 1]).toBe(PET_EXPRESSION_CYCLE[step]);
    }

    vi.advanceTimersByTime(5000);
    expect(calls[calls.length - 1]).toBe(PET_EXPRESSION_CYCLE[0]);

    c.stop();
    const n = calls.length;
    vi.advanceTimersByTime(50000);
    expect(calls.length).toBe(n);
  });

  it('stop 后不再触发 setState', function () {
    const fn = vi.fn();
    const c = createPetExpressionCycle(fn, ['a', 'b'], 5000);
    expect(fn.mock.calls.length).toBe(1);
    c.stop();
    vi.advanceTimersByTime(1_000_000);
    expect(fn.mock.calls.length).toBe(1);
  });
});
