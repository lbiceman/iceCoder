import { describe, expect, it } from 'vitest';

import {
  detectIncompleteForwardSignal,
  evaluateIncompleteTaskStopHook,
} from '../../src/harness/incomplete-task-stop-hook.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function msgs(...pairs: Array<[string, string]>): UnifiedMessage[] {
  return pairs.map(([role, content]) => ({ role: role as 'user' | 'assistant', content }));
}

describe('incomplete-task-stop-hook (text-only fallback)', () => {
  it('does not treat retrospective npm test mentions as forward incomplete signals', () => {
    const summary = [
      '## 验收',
      '- npm test: 22/22 通过',
      '- manifest.json 已更新',
      '- colorVariance 审计通过',
    ].join('\n');
    expect(detectIncompleteForwardSignal(summary)).toBe(false);
  });

  it('detects explicit forward incomplete intent (中英文)', () => {
    expect(detectIncompleteForwardSignal('接下来我会修复 E2E webServer 超时。')).toBe(true);
    expect(detectIncompleteForwardSignal('I will fix the playwright config next.')).toBe(true);
    expect(detectIncompleteForwardSignal('still need to add deployment section')).toBe(true);
  });

  it('returns shouldContinue=false on neutral summary text', () => {
    const result = evaluateIncompleteTaskStopHook(msgs(['user', '修复 bug']), '修复完成。npm test 通过。');
    expect(result.shouldContinue).toBe(false);
    expect(result.message).toBeUndefined();
  });

  it('returns shouldContinue=true with continuation message on forward signal', () => {
    const result = evaluateIncompleteTaskStopHook(
      msgs(['user', '修复 bug']),
      '我修了一半，接下来我会继续修复剩余的 case。',
    );
    expect(result.shouldContinue).toBe(true);
    expect(result.message).toContain('Continue by calling tools');
    expect(result.hookName).toBe('incomplete_task_check');
  });
});
