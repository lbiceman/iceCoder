import { describe, expect, it, vi } from 'vitest';

import { handleNoToolCalls } from '../../src/harness/harness-round-no-tools.js';
import { maybeResetVerificationGateCounter } from '../../src/harness/harness-verification-gate.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import { StopHookManager } from '../../src/harness/stop-hooks.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function makeState(messages: UnifiedMessage[], goal = 'fix bug'): HarnessRunState {
  return {
    messages,
    tools: [
      { name: 'run_command', description: 'run', parameters: { type: 'object', properties: {} } },
      { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } },
    ],
    turnCount: 1,
    maxOutputTokensRecoveryCount: 0,
    llmRetryCount: 0,
    emptyResponseRetryCount: 0,
    reasoningOnlyRecoveryCount: 0,
    prematureCompletionRecoveryCount: 0,
    consecutiveToolFailures: 0,
    consecutiveReadOnlyRounds: 0,
    noToolExecutionRecoveryCount: 0,
    taskSwitchInjected: false,
    stopHookContinuationCount: 0,
    verificationGateContinuationCount: 1,
    failedUnitTestReminderInjected: false,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: new TaskState(goal),
    repoContext: new RepoContext(),
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    stepReviewedThisRound: false,
    executionMode: 'free',
    executionModeLockRemaining: 0,
    executionModeEnteredBy: [],
    pendingModeSignals: [],
    forcedTaskBearingRoundsSinceEntry: 0,
    supervisorPhase: 'free',
    recoveryPendingSticky: false,
    stableRoundsSinceLastFailure: 0,
    filesChangedAtRoundStart: 0,
    branchSwitchedThisRound: false,
  };
}

function makeDeps() {
  return {
    loopController: new LoopController({ maxRounds: 10 }),
    stopHookManager: new StopHookManager(),
    memoryIntegration: { getSessionMemoryForCompact: async () => null } as any,
    graphExecutor: { hasGraph: () => false, advanceOrComplete: () => ({ graphDone: false }) } as any,
    enqueueCheckpointPersist: async (t: () => Promise<void>) => t(),
  };
}

function makeLogger() {
  return {
    loopStop: vi.fn(),
    getEntries: vi.fn(() => []),
  } as any;
}

describe('verification gate counter integration', () => {
  it('failed npm test triggers failed-test reminder inject', async () => {
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'fix bug' }];
    const state = makeState(messages, 'fix bug');
    state.noToolExecutionRecoveryCount = 1;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.taskState.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: false, output: 'FAIL', error: 'exit 1' },
    );

    expect(state.taskState.pendingFileDeliverableCount()).toBe(0);
    expect(state.taskState.isVerificationBlockingFinal()).toBe(false);

    const result = await handleNoToolCalls(makeDeps(), {
      state,
      response: { content: '测试失败，总结。', finishReason: 'stop' },
      userMessage: 'fix bug',
      currentTools: state.tools,
      tokenUsage: { input: 1, output: 1 },
      logger: makeLogger(),
    });

    expect(result.action).toBe('continue');
    expect(state.failedUnitTestReminderInjected).toBe(true);
    expect(state.verificationGateContinuationCount).toBe(0);
  });

  it('passing npm test clears pending and resets counter', () => {
    const state = makeState([{ role: 'user', content: 'fix bug' }], 'fix bug');
    state.verificationGateContinuationCount = 4;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    state.taskState.recordToolResult(
      { id: 'w2', name: 'edit_file', arguments: { path: 'src/b.ts' } },
      { success: true, output: 'ok' },
    );

    const pendingBefore = state.taskState.pendingFileDeliverableCount();
    state.taskState.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      { success: true, output: 'ok' },
    );
    const pendingAfter = state.taskState.pendingFileDeliverableCount();
    const blockingAfter = state.taskState.isVerificationBlockingFinal();

    maybeResetVerificationGateCounter(state, pendingBefore, pendingAfter, blockingAfter);
    expect(pendingBefore).toBe(1);
    expect(pendingAfter).toBe(0);
    expect(state.verificationGateContinuationCount).toBe(0);
    expect(blockingAfter).toBe(false);
  });
});
