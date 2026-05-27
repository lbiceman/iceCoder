import { describe, expect, it } from 'vitest';

import {
  isLongRunningImplementationGoal,
  isResumeContinuationMessage,
  resolveEffectiveUserGoal,
} from '../../src/harness/resume-goal.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('isResumeContinuationMessage', () => {
  it('recognizes common continuation phrases', () => {
    expect(isResumeContinuationMessage('继续')).toBe(true);
    expect(isResumeContinuationMessage('Continue')).toBe(true);
    expect(isResumeContinuationMessage('resume')).toBe(true);
  });

  it('rejects substantive new requests', () => {
    expect(isResumeContinuationMessage('继续实现 npm test')).toBe(false);
    expect(isResumeContinuationMessage('fix the manifest')).toBe(false);
  });
});

describe('resolveEffectiveUserGoal', () => {
  it('inherits first substantial user goal when user says 继续', () => {
    const benchmarkGoal = 'E:\\test\\implement-spellbrigade-survivor-second\n\n从零实现 survivors roguelike。'.padEnd(120, 'x');
    const messages: UnifiedMessage[] = [
      { role: 'user', content: benchmarkGoal },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '继续' },
    ];
    expect(resolveEffectiveUserGoal('继续', messages)).toBe(benchmarkGoal);
  });

  it('returns user message when not a continuation', () => {
    const msg = 'fix npm test failures in tasks.ts';
    expect(resolveEffectiveUserGoal(msg, [])).toBe(msg);
  });
});

describe('isLongRunningImplementationGoal', () => {
  it('detects benchmark-style prompts', () => {
    const goal = 'implement-spellbrigade-survivor\n\n从零实现 Phase 1-5，验收命令 npm ci → npm test → npm run build';
    expect(isLongRunningImplementationGoal(goal)).toBe(true);
  });

  it('rejects short casual messages', () => {
    expect(isLongRunningImplementationGoal('继续')).toBe(false);
  });
});
