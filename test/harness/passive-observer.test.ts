import { describe, expect, it } from 'vitest';

import {
  maxFailedSignatureCount,
  PassiveObserver,
  topFileEditFromInspect,
} from '../../src/harness/supervisor/passive-observer.js';

const DEFAULT_TRIGGERS = {
  toolRepeatFailMin: 2,
  noProgressRoundsMin: 3,
  fileLoopMin: 4,
  goalDriftEnabled: true,
  scopeCreepEnabled: true,
  userForceTakeoverEnabled: true,
};

function baseInput() {
  return {
    phase: 'free' as const,
    round: { round: 1, toolNames: ['read_file'], toolSuccess: [true], hadWriteTool: false },
    consecutiveToolFailures: 0,
    consecutiveReadOnlyRounds: 0,
    stableRoundsSinceLastFailure: 1,
    allToolsFailedThisRound: false,
    repeatedToolSignatures: [] as string[],
    maxFailedSignatureCount: 0,
    branchRecoverTriggered: false,
  };
}

describe('PassiveObserver - L2-2', () => {
  it('emits tool_repeat_fail when max failed signature count reaches threshold', () => {
    const observer = new PassiveObserver(DEFAULT_TRIGGERS);
    const signals = observer.observe({
      ...baseInput(),
      maxFailedSignatureCount: 2,
      repeatedToolSignatures: ['edit_file:foo'],
    });

    expect(signals).toEqual([{ type: 'tool_repeat_fail', count: 2 }]);
    expect(observer.getAccumulated()).toHaveLength(1);
  });

  it('emits no_progress when consecutive read-only rounds exceed threshold', () => {
    const observer = new PassiveObserver(DEFAULT_TRIGGERS);
    const signals = observer.observe({
      ...baseInput(),
      consecutiveReadOnlyRounds: 3,
    });

    expect(signals).toEqual([{ type: 'no_progress', rounds: 3 }]);
  });

  it('emits file_loop when single file edit count exceeds fileLoopMin', () => {
    const observer = new PassiveObserver(DEFAULT_TRIGGERS);
    const signals = observer.observe({
      ...baseInput(),
      topFileEdit: { path: 'src/a.ts', count: 4 },
    });

    expect(signals).toEqual([{ type: 'file_loop', path: 'src/a.ts', count: 4 }]);
  });

  it('returns empty when no threshold crossed', () => {
    const observer = new PassiveObserver(DEFAULT_TRIGGERS);
    expect(observer.observe(baseInput())).toEqual([]);
  });

  it('reset clears accumulated signals', () => {
    const observer = new PassiveObserver(DEFAULT_TRIGGERS);
    observer.observe({ ...baseInput(), maxFailedSignatureCount: 3 });
    observer.reset();
    expect(observer.getAccumulated()).toEqual([]);
  });
});

describe('PassiveObserver helpers', () => {
  it('maxFailedSignatureCount returns peak count', () => {
    const map = new Map([['a', 1], ['b', 3]]);
    expect(maxFailedSignatureCount(map)).toBe(3);
  });

  it('topFileEditFromInspect picks highest count', () => {
    expect(topFileEditFromInspect({ 'a.ts': 2, 'b.ts': 5 })).toEqual({ path: 'b.ts', count: 5 });
  });
});
