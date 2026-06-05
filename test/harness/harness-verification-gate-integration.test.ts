import { describe, expect, it, vi } from 'vitest';

import { handleNoToolCalls } from '../../src/harness/harness-round-no-tools.js';
import { maybeResetVerificationGateCounter } from '../../src/harness/harness-verification-gate.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { TaskState } from '../../src/harness/task-state.js';
import { StopHookManager } from '../../src/harness/stop-hooks.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function makeState(messages: UnifiedMessage[], goal = '写 md'): HarnessRunState {
  return {
    messages,
    tools: [
      { name: 'file_info', description: 'info', parameters: { type: 'object', properties: {} } },
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
  it('ineffective file_info keeps counter; next gate inject increments to 2/5', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const messages: UnifiedMessage[] = [{ role: 'user', content: '写两份 md' }];
    const state = makeState(messages, '写两份 md');
    state.taskState.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'notes.md' } },
      { success: true, output: 'ok' },
    );
    state.taskState.recordToolResult(
      { id: 'w2', name: 'write_file', arguments: { path: 'report.md' } },
      { success: true, output: 'ok' },
    );
    state.taskState.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: 'notes.md' } },
      { success: true, output: JSON.stringify({ size: 12, type: 'file' }) },
    );

    const pendingBefore = state.taskState.pendingFileDeliverableCount();
    state.taskState.reconcileOrphanFileDeliverableWriteVersions();
    state.taskState.recordToolResult(
      { id: 'f2', name: 'file_info', arguments: { path: 'notes.md' } },
      { success: true, output: JSON.stringify({ size: 12, type: 'file' }) },
    );
    const pendingAfter = state.taskState.pendingFileDeliverableCount();
    const blockingAfter = state.taskState.isVerificationBlockingFinal();

    maybeResetVerificationGateCounter(state, pendingBefore, pendingAfter, blockingAfter);
    expect(state.verificationGateContinuationCount).toBe(1);
    expect(pendingBefore).toBe(1);
    expect(pendingAfter).toBe(1);

    const result = await handleNoToolCalls(makeDeps(), {
      state,
      response: { content: '两份文档都写好了。', finishReason: 'stop' },
      userMessage: '写两份 md',
      currentTools: state.tools,
      tokenUsage: { input: 1, output: 1 },
      logger: makeLogger(),
    });

    expect(result.action).toBe('continue');
    expect(state.verificationGateContinuationCount).toBe(2);
    expect(logSpy).toHaveBeenCalledWith('[harness] verification gate 注入 (2/5)');
    logSpy.mockRestore();
  });

  it('effective file_info reduces pending and resets counter', () => {
    const state = makeState([{ role: 'user', content: '写 md' }], '写 md');
    state.verificationGateContinuationCount = 4;
    state.taskState.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'notes.md' } },
      { success: true, output: 'ok' },
    );
    state.taskState.recordToolResult(
      { id: 'w2', name: 'write_file', arguments: { path: 'report.md' } },
      { success: true, output: 'ok' },
    );

    const pendingBefore = state.taskState.pendingFileDeliverableCount();
    state.taskState.reconcileOrphanFileDeliverableWriteVersions();
    state.taskState.recordToolResult(
      { id: 'f1', name: 'file_info', arguments: { path: 'notes.md' } },
      { success: true, output: JSON.stringify({ size: 12, type: 'file' }) },
    );
    const pendingAfter = state.taskState.pendingFileDeliverableCount();
    const blockingAfter = state.taskState.isVerificationBlockingFinal();

    maybeResetVerificationGateCounter(state, pendingBefore, pendingAfter, blockingAfter);
    expect(pendingBefore).toBe(2);
    expect(pendingAfter).toBe(1);
    expect(state.verificationGateContinuationCount).toBe(0);
    expect(blockingAfter).toBe(true);
  });
});
