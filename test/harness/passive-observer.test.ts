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
  it('does not emit tool_repeat_fail from cumulative history when this round succeeded', () => {
    const observer = new PassiveObserver(DEFAULT_TRIGGERS);
    const signals = observer.observe({
      ...baseInput(),
      maxFailedSignatureCount: 5,
      repeatedToolSignatures: [],
      allToolsFailedThisRound: false,
      branchRecoverTriggered: false,
    });
    expect(signals).toEqual([]);
  });

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
    observer.observe({
      ...baseInput(),
      maxFailedSignatureCount: 3,
      allToolsFailedThisRound: true,
      consecutiveToolFailures: 3,
    });
    observer.reset();
    expect(observer.getAccumulated()).toEqual([]);
  });

  it('调优 B1: 同 type signal 滑窗保留最近 3 条（observe）', () => {
    const observer = new PassiveObserver(DEFAULT_TRIGGERS);
    for (let i = 0; i < 5; i++) {
      observer.observe({
        ...baseInput(),
        round: { round: i + 1, toolNames: ['edit_file'], toolSuccess: [false], hadWriteTool: false },
        maxFailedSignatureCount: 2 + i,
        repeatedToolSignatures: ['edit_file:x'],
      });
    }
    const acc = observer.getAccumulated();
    const repeatFails = acc.filter(s => s.type === 'tool_repeat_fail');
    expect(repeatFails).toHaveLength(3);
    // 保留的应该是后 3 条（count 4/5/6），最老的（count 2/3）被丢弃
    expect(repeatFails.map(s => (s as { count: number }).count)).toEqual([4, 5, 6]);
  });

  it('调优 B1: pushSignal 多次 goal_drift 也仅保留 3 条', () => {
    const observer = new PassiveObserver(DEFAULT_TRIGGERS);
    const alignments = [0.42, 0.41, 0.40, 0.39, 0.38, 0.37];
    for (const a of alignments) {
      observer.pushSignal({ type: 'goal_drift', alignment: a });
    }
    const acc = observer.getAccumulated().filter(s => s.type === 'goal_drift');
    expect(acc).toHaveLength(3);
    expect(acc.map(s => (s as { alignment: number }).alignment)).toEqual([0.39, 0.38, 0.37]);
  });

  it('调优 B1: 不同 type 各自维护滑窗，互不影响', () => {
    const observer = new PassiveObserver(DEFAULT_TRIGGERS);
    for (let i = 0; i < 4; i++) {
      observer.observe({
        ...baseInput(),
        maxFailedSignatureCount: 2,
        repeatedToolSignatures: ['edit_file:x'],
        consecutiveReadOnlyRounds: 3,
      });
    }
    const acc = observer.getAccumulated();
    expect(acc.filter(s => s.type === 'tool_repeat_fail')).toHaveLength(3);
    expect(acc.filter(s => s.type === 'no_progress')).toHaveLength(3);
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
