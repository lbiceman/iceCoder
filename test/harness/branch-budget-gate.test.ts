import { describe, expect, it } from 'vitest';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';

describe('BranchBudgetTracker.setEnabled - Batch 5 / W1', () => {
  it('defaults to enabled and records normally', () => {
    const tracker = new BranchBudgetTracker();
    expect(tracker.isEnabled()).toBe(true);

    tracker.recordFileEdit('src/a.ts');
    tracker.recordFileEdit('src/a.ts');
    expect(tracker.inspect().fileEdits['src/a.ts']).toBe(2);
  });

  it('skips all writes and recovery decisions when disabled', () => {
    const tracker = new BranchBudgetTracker({ commandRetryMax: 1 });
    tracker.setEnabled(false);

    expect(tracker.recordFileEdit('src/a.ts')).toBe(0);
    expect(tracker.recordFailedCommandAttempt('npm test')).toBe(0);
    expect(tracker.recordError('boom')).toBe(0);

    expect(tracker.inspect()).toEqual({ fileEdits: {}, commandRetries: {}, errorRepeats: {} });
    expect(tracker.shouldBranchRecover().triggered).toBe(false);
    expect(tracker.buildRecoverySignal()).toBeNull();
  });

  it('resumes recording after re-enabling without losing prior counts', () => {
    const tracker = new BranchBudgetTracker();
    tracker.recordFileEdit('src/a.ts');
    tracker.setEnabled(false);
    tracker.recordFileEdit('src/a.ts');
    tracker.setEnabled(true);
    tracker.recordFileEdit('src/a.ts');

    expect(tracker.inspect().fileEdits['src/a.ts']).toBe(2);
  });
});
