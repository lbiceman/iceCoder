import { describe, expect, it } from 'vitest';

import { CorrectionBudgetTracker } from '../../src/harness/supervisor/correction-budget.js';
import type { CorrectionBlock } from '../../src/types/supervisor.js';

function block(kind: CorrectionBlock['kind']): CorrectionBlock {
  return { kind, content: `[Test:${kind}]` };
}

describe('CorrectionBudgetTracker · §2.6 I4', () => {
  it('only counts supervisor recovery/graph_hint blocks emitted while phase=free', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 2 });

    expect(tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'supervisor' })).toBe(true);
    expect(tracker.tryConsume({ block: block('graph_hint'), phase: 'free', source: 'supervisor' })).toBe(true);

    expect(tracker.snapshot()).toEqual({ used: 2, max: 2, rejected: 0 });
    expect(tracker.remaining()).toBe(0);
  });

  it('rejects subsequent inject once freeSegmentMaxPerTask is reached', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 1 });
    tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'supervisor' });

    expect(tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'supervisor' })).toBe(false);
    expect(tracker.tryConsume({ block: block('graph_hint'), phase: 'free', source: 'supervisor' })).toBe(false);
    expect(tracker.snapshot()).toEqual({ used: 1, max: 1, rejected: 2 });
  });

  it('does not count takeover / handoff_pending / cooldown phases', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 1 });
    expect(tracker.tryConsume({ block: block('recovery'), phase: 'takeover', source: 'supervisor' })).toBe(true);
    expect(tracker.tryConsume({ block: block('graph_hint'), phase: 'handoff_pending', source: 'supervisor' })).toBe(true);
    expect(tracker.tryConsume({ block: block('recovery'), phase: 'cooldown', source: 'supervisor' })).toBe(true);
    expect(tracker.snapshot().used).toBe(0);
  });

  it('does not count non-supervisor sources (lifecycle / memory / compaction)', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 1 });
    expect(tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'lifecycle' })).toBe(true);
    expect(tracker.tryConsume({ block: block('graph_hint'), phase: 'free', source: 'memory' })).toBe(true);
    expect(tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'compaction' })).toBe(true);
    expect(tracker.snapshot().used).toBe(0);
  });

  it('does not count takeover / shadow_diagnostic block kinds', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 1 });
    expect(tracker.tryConsume({ block: block('takeover'), phase: 'free', source: 'supervisor' })).toBe(true);
    expect(tracker.tryConsume({ block: block('shadow_diagnostic'), phase: 'free', source: 'supervisor' })).toBe(true);
    expect(tracker.snapshot().used).toBe(0);
  });

  it('restoreUsed preserves used count across checkpoint resume', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 3 });
    tracker.restoreUsed(2);
    expect(tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'supervisor' })).toBe(true);
    expect(tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'supervisor' })).toBe(false);
    expect(tracker.snapshot()).toEqual({ used: 3, max: 3, rejected: 1 });
  });

  it('reset clears used and rejected counters', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 1 });
    tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'supervisor' });
    tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'supervisor' });
    expect(tracker.snapshot()).toEqual({ used: 1, max: 1, rejected: 1 });

    tracker.reset();
    expect(tracker.snapshot()).toEqual({ used: 0, max: 1, rejected: 0 });
  });

  it('clamps negative restoreUsed to 0 and never under-counts remaining', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 2 }, -5);
    expect(tracker.snapshot()).toEqual({ used: 0, max: 2, rejected: 0 });
    tracker.restoreUsed(-10);
    expect(tracker.remaining()).toBe(2);
  });

  it('treats freeSegmentMaxPerTask=0 as a strict no-supervisor-inject policy on free', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 0 });
    expect(tracker.tryConsume({ block: block('recovery'), phase: 'free', source: 'supervisor' })).toBe(false);
    expect(tracker.snapshot()).toEqual({ used: 0, max: 0, rejected: 1 });
  });
});
