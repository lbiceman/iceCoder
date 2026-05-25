import { describe, expect, it } from 'vitest';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { resilienceMaybeBranchRecover } from '../../src/harness/harness-resilience.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function stateWithBranchBudget(branchBudget: BranchBudgetTracker): HarnessRunState {
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
    branchBudget,
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    stepReviewedThisRound: false,
    supervisorPhase: 'free',
  };
}

describe('harness resilience correction routing - Batch 5', () => {
  it('skips branch recovery inject when supervisorObserverSuppressInject is set', () => {
    const branchBudget = new BranchBudgetTracker({ commandRetryMax: 1 });
    branchBudget.recordFailedCommandAttempt('npm test');
    branchBudget.recordFailedCommandAttempt('npm test');
    const messages: UnifiedMessage[] = [];
    const state = stateWithBranchBudget(branchBudget);

    resilienceMaybeBranchRecover({
      resilienceV2Enabled: true,
      checkpointEngine: { save: async () => undefined } as never,
      enqueueCheckpointPersist: async task => task(),
      supervisorObserverSuppressInject: true,
    }, state, messages);

    expect(messages).toHaveLength(0);
    expect(state.branchBudgetWarnedThisRound).toBe(true);
  });

  it('keeps legacy branch recovery injection when no CorrectionPort is supplied', () => {
    const branchBudget = new BranchBudgetTracker({ commandRetryMax: 1 });
    branchBudget.recordFailedCommandAttempt('npm test');
    branchBudget.recordFailedCommandAttempt('npm test');
    const messages: UnifiedMessage[] = [];
    const state = stateWithBranchBudget(branchBudget);

    resilienceMaybeBranchRecover({
      resilienceV2Enabled: true,
      checkpointEngine: { save: async () => undefined } as never,
      enqueueCheckpointPersist: async task => task(),
    }, state, messages);

    expect(messages.some(m =>
      m.role === 'user'
      && typeof m.content === 'string'
      && m.content.includes('Current branch exhausted')
    )).toBe(true);
  });
});
