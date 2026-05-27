import { describe, expect, it } from 'vitest';

import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { markForcedDegraded } from '../../src/harness/supervisor/execution-mode-constraints.js';

function state(overrides: Partial<HarnessRunState> = {}): HarnessRunState {
  return {
    messages: [],
    tools: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    llmRetryCount: 0,
    emptyResponseRetryCount: 0,
    consecutiveToolFailures: 0,
    consecutiveReadOnlyRounds: 0,
    noToolExecutionRecoveryCount: 0,
    taskSwitchInjected: false,
    stopHookContinuationCount: 0,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: undefined as never,
    repoContext: undefined as never,
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    stepReviewedThisRound: false,
    supervisorPhase: 'free',
    ...overrides,
  };
}

describe('Execution mode forced degraded - Batch 5', () => {
  it('records degraded tier without lowering forced execution to free', () => {
    const s = state({ executionMode: 'forced' });

    markForcedDegraded(s, 'graph');

    expect(s.executionMode).toBe('forced');
    expect(s.forcedDegradedTier).toBe('graph');
  });

  it('does not invent degraded state while execution remains free', () => {
    const s = state({ executionMode: 'free' });

    markForcedDegraded(s, 'graph');

    expect(s.executionMode).toBe('free');
    expect(s.forcedDegradedTier).toBeUndefined();
  });
});
