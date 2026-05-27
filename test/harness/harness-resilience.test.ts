import { describe, expect, it } from 'vitest';

import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { resilienceMaybeBranchRecover, resilienceRecordToolCalls } from '../../src/harness/harness-resilience.js';
import { toolCallSignature } from '../../src/harness/harness-permission-runtime.js';
import type { UnifiedMessage, ToolCall } from '../../src/llm/types.js';

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

  it('does not increment command retry budget for policy-blocked run_command signatures', async () => {
    const branchBudget = new BranchBudgetTracker({ commandRetryMax: 2 });
    branchBudget.recordFailedCommandAttempt('npm run build 2>&1');
    branchBudget.recordFailedCommandAttempt('npm run build 2>&1');
    const tc: ToolCall = {
      id: 'tc-build',
      name: 'run_command',
      arguments: { command: 'npm run build 2>&1' },
    };
    const state = stateWithBranchBudget(branchBudget);

    await resilienceRecordToolCalls(
      {
        resilienceV2Enabled: true,
        checkpointEngine: {
          save: async () => undefined,
          shouldPersistOnTrigger: () => false,
        } as never,
        enqueueCheckpointPersist: async task => task(),
      },
      [tc],
      new Set(),
      new Set([toolCallSignature(tc)]),
      state,
    );

    expect(branchBudget.inspect().commandRetries['npm run build 2>&1']).toBe(2);
  });

  it('does not increment file edit budget for policy-blocked write_file', async () => {
    const branchBudget = new BranchBudgetTracker({ fileEditMax: 3 });
    branchBudget.recordFileEdit('src/a.ts');
    branchBudget.recordFileEdit('src/a.ts');
    const tc: ToolCall = {
      id: 'tc-write',
      name: 'write_file',
      arguments: { path: 'src/a.ts', content: 'x' },
    };
    const state = stateWithBranchBudget(branchBudget);

    await resilienceRecordToolCalls(
      {
        resilienceV2Enabled: true,
        checkpointEngine: {
          save: async () => undefined,
          shouldPersistOnTrigger: () => false,
        } as never,
        enqueueCheckpointPersist: async task => task(),
      },
      [tc],
      new Set(),
      new Set([toolCallSignature(tc)]),
      state,
    );

    expect(branchBudget.inspect().fileEdits['src/a.ts']).toBe(2);
  });

  it('increments file edit budget only when write_file actually succeeded', async () => {
    const branchBudget = new BranchBudgetTracker({ fileEditMax: 3 });
    const tc: ToolCall = {
      id: 'tc-write',
      name: 'write_file',
      arguments: { path: 'src/a.ts', content: 'x' },
    };
    const state = stateWithBranchBudget(branchBudget);

    await resilienceRecordToolCalls(
      {
        resilienceV2Enabled: true,
        checkpointEngine: {
          save: async () => undefined,
          shouldPersistOnTrigger: () => false,
        } as never,
        enqueueCheckpointPersist: async task => task(),
      },
      [tc],
      new Set(),
      new Set(),
      state,
    );

    expect(branchBudget.inspect().fileEdits['src/a.ts']).toBe(1);
  });
});
