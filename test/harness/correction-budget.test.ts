import { describe, expect, it } from 'vitest';

import { CorrectionBudgetTracker } from '../../src/harness/supervisor/correction-budget.js';

describe('CorrectionBudgetTracker · §2.6 I4', () => {
  it('increments used on each tryConsume until max is reached', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 2 });

    expect(tracker.tryConsume()).toBe(true);
    expect(tracker.tryConsume()).toBe(true);

    expect(tracker.snapshot()).toEqual({ used: 2, max: 2, rejected: 0 });
    expect(tracker.remaining()).toBe(0);
  });

  it('rejects subsequent tryConsume once freeSegmentMaxPerTask is reached', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 1 });
    tracker.tryConsume();

    expect(tracker.tryConsume()).toBe(false);
    expect(tracker.tryConsume()).toBe(false);
    expect(tracker.snapshot()).toEqual({ used: 1, max: 1, rejected: 2 });
  });

  it('restoreUsed preserves used count across checkpoint resume', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 3 });
    tracker.restoreUsed(2);
    expect(tracker.tryConsume()).toBe(true);
    expect(tracker.tryConsume()).toBe(false);
    expect(tracker.snapshot()).toEqual({ used: 3, max: 3, rejected: 1 });
  });

  it('reset clears used and rejected counters', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 1 });
    tracker.tryConsume();
    tracker.tryConsume();
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

  it('treats freeSegmentMaxPerTask=0 as immediate rejection', () => {
    const tracker = new CorrectionBudgetTracker({ freeSegmentMaxPerTask: 0 });
    expect(tracker.tryConsume()).toBe(false);
    expect(tracker.snapshot()).toEqual({ used: 0, max: 0, rejected: 1 });
  });
});
