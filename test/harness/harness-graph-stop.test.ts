import { describe, expect, it, vi } from 'vitest';

import { shouldBlockGraphTerminalStop, tryGraphTerminalStop } from '../../src/harness/harness-graph-stop.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import { markGraphFailed } from '../../src/harness/task-graph.js';
import { TaskState } from '../../src/harness/task-state.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';

function makeState(): HarnessRunState {
  return {
    messages: [{ role: 'assistant', content: '图已完成总结' }],
    tools: [],
    turnCount: 2,
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
    verificationGateContinuationCount: 0,
    transition: 'initial',
    justCompacted: false,
    amnesiaRecoveryCount: 0,
    taskState: new TaskState('fix tests'),
    repoContext: new RepoContext(),
    runtimeStateHash: '',
    failedToolCallSignatures: new Map(),
    branchBudgetWarnedThisRound: false,
    verificationDigestInjectedThisRound: false,
    rebuildEscalationInjections: 0,
    rebuildEscalationInjectedThisRound: false,
    parallelBudgetBlockHintInjected: false,
    segmentRenewalCount: 0,
    verificationOutputBuffer: { snapshot: () => [], restore: () => {}, append: () => {} } as any,
    consecutiveNoToolRounds: 0,
    missingFileAttempts: new Map(),
    harnessPolicyStats: {
      policyBlockCount: 0,
      rebuildEscalationCount: 0,
      verificationDigestCount: 0,
    },
    checkpointResumeForkApplied: false,
    contextEmergencyCompactUsed: false,
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

function finishGraph(executor: GraphExecutor): void {
  executor.initGraph({ goal: 'fix tests', intent: 'test' });
  for (let i = 0; i < 10; i++) {
    if (executor.advanceOrComplete().graphDone) break;
  }
}

describe('tryGraphTerminalStop', () => {
  it('图 terminal 且无 pendingWork 时强制 model_done', async () => {
    const loopController = new LoopController({ maxRounds: 10 });
    const executor = new GraphExecutor();
    finishGraph(executor);
    expect(executor.isGraphDoneForHarnessStop()).toBe(true);

    const onStep = vi.fn();
    const logger = { loopStop: vi.fn(), getEntries: vi.fn(() => []) };

    const result = await tryGraphTerminalStop(
      {
        loopController,
        enqueueCheckpointPersist: async (t) => t(),
        resilienceV2Enabled: false,
      },
      {
        state: makeState(),
        graphExecutor: executor,
        userMessage: 'fix tests',
        currentTools: [],
        logger: logger as any,
        onStep,
      },
    );

    expect(result).not.toBeNull();
    expect(result!.loopState.stopReason).toBe('model_done');
    expect(result!.content).toContain('图已完成总结');
    expect(onStep).toHaveBeenCalledWith(expect.objectContaining({ type: 'task_graph_done' }));
  });

  it('pendingWork 存在时不强制停止', async () => {
    const loopController = new LoopController({ maxRounds: 10 });
    const executor = new GraphExecutor();
    finishGraph(executor);

    const state = makeState();
    const snap = state.taskState.snapshot();
    state.taskState.applySnapshot({
      ...snap,
      filesChanged: ['src/a.ts'],
      verificationRequired: true,
      verificationStatus: 'required',
    });

    const result = await tryGraphTerminalStop(
      {
        loopController,
        enqueueCheckpointPersist: async (t) => t(),
        resilienceV2Enabled: false,
      },
      {
        state,
        graphExecutor: executor,
        userMessage: 'fix tests',
        currentTools: [],
        logger: { loopStop: vi.fn(), getEntries: vi.fn(() => []) } as any,
      },
    );

    expect(result).toBeNull();
  });

  it('写后读 pending（有 writeVersion 无 confirm）时不强制停止', async () => {
    const loopController = new LoopController({ maxRounds: 10 });
    const executor = new GraphExecutor();
    finishGraph(executor);

    const state = makeState();
    state.taskState.recordToolResult(
      { id: 'w1', name: 'write_file', arguments: { path: 'src/a.ts' } },
      { success: true, output: 'ok' },
    );
    expect(shouldBlockGraphTerminalStop(state)).toBe(true);

    const result = await tryGraphTerminalStop(
      {
        loopController,
        enqueueCheckpointPersist: async (t) => t(),
        resilienceV2Enabled: false,
      },
      {
        state,
        graphExecutor: executor,
        userMessage: 'fix tests',
        currentTools: [],
        logger: { loopStop: vi.fn(), getEntries: vi.fn(() => []) } as any,
      },
    );

    expect(result).toBeNull();
  });

  it('verificationStatus=failed 时 hasPendingWork 拦截 graph-stop', async () => {
    const loopController = new LoopController({ maxRounds: 10 });
    const executor = new GraphExecutor();
    finishGraph(executor);

    const state = makeState();
    const snap = state.taskState.snapshot();
    state.taskState.applySnapshot({
      ...snap,
      filesChanged: [],
      verificationRequired: true,
      verificationStatus: 'failed',
    });
    expect(shouldBlockGraphTerminalStop(state)).toBe(true);

    const result = await tryGraphTerminalStop(
      {
        loopController,
        enqueueCheckpointPersist: async (t) => t(),
        resilienceV2Enabled: false,
      },
      {
        state,
        graphExecutor: executor,
        userMessage: 'fix tests',
        currentTools: [],
        logger: { loopStop: vi.fn(), getEntries: vi.fn(() => []) } as any,
      },
    );

    expect(result).toBeNull();
  });

  it('graph failed 时不强制 model_done', async () => {
    const loopController = new LoopController({ maxRounds: 10 });
    const executor = new GraphExecutor();
    executor.initGraph({ goal: 'fix tests', intent: 'test' });
    const internal = executor as unknown as { graph: Parameters<typeof markGraphFailed>[0] };
    markGraphFailed(internal.graph, 'branch exhausted');

    const result = await tryGraphTerminalStop(
      {
        loopController,
        enqueueCheckpointPersist: async (t) => t(),
        resilienceV2Enabled: false,
      },
      {
        state: makeState(),
        graphExecutor: executor,
        userMessage: 'fix tests',
        currentTools: [],
        logger: { loopStop: vi.fn(), getEntries: vi.fn(() => []) } as any,
      },
    );

    expect(result).toBeNull();
  });
});
