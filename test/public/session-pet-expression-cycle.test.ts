/**
 * 会话宠物表情轮播逻辑：每 intervalMs 切换一次 setState。
 * 与 src/public/js/session-pet.js 中 EXPRESSIONS 键一致（不含 blink，blink 由内部眨眼定时器驱动）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 与 SessionPet EXPRESSIONS 对外键一致（不含 blink） */
export const PET_EXPRESSION_CYCLE = [
  'idle',
  'happy',
  'thinking',
  'working',
  'confused',
  'alert',
  'anxious',
  'rest',
  'surprised',
  'sad',
  'angry',
  'curious',
  'dizzy',
  'shy',
  'love',
  'weary',
  'focused',
  'read',
  'determined',
  'playful',
] as const;

export type PetExpressionId = (typeof PET_EXPRESSION_CYCLE)[number];

describe('PET_EXPRESSION_CYCLE 与 session-pet.js 同步', () => {
  it('对外表情键在 session-pet.js 的 EXPRESSIONS 映射表中存在', () => {
    var sessionPetPath = path.join(__dirname, '../../src/public/js/session-pet.js');
    var src = readFileSync(sessionPetPath, 'utf-8');
    for (var i = 0; i < PET_EXPRESSION_CYCLE.length; i++) {
      var id = PET_EXPRESSION_CYCLE[i];
      expect(src).toMatch(new RegExp('\\b' + id + '\\s*:\\s*expression'));
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
