import { describe, expect, it, vi } from 'vitest';

import { evaluateSupervisorAfterNoToolRound } from '../../src/harness/harness-supervisor-round.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { TaskState } from '../../src/harness/task-state.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import { resolveSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import { createSupervisorRuntimeBridge } from '../../src/harness/supervisor/supervisor-bridge.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';

function makeState(bridge: ReturnType<typeof createSupervisorRuntimeBridge>): HarnessRunState {
  return {
    messages: [],
    tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
    turnCount: 3,
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
    taskState: new TaskState('fix unit tests in src/login.ts'),
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
    consecutiveNoToolRounds: 5,
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
    supervisorBridge: bridge,
    recoveryPendingSticky: false,
    stableRoundsSinceLastFailure: 0,
    filesChangedAtRoundStart: 0,
    branchSwitchedThisRound: false,
  };
}

describe('evaluateSupervisorAfterNoToolRound', () => {
  it('连续无工具轮会累积 no_progress 信号', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive', triggers: { noProgressRoundsMin: 4 } }, {});
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const loopController = new LoopController({ maxRounds: 20 });
    const state = makeState(bridge);

    const result = await evaluateSupervisorAfterNoToolRound(
      {
        loopController,
        graphExecutor: new GraphExecutor(),
        workspaceRoot: process.cwd(),
        supervisorBridge: bridge,
        enqueueCheckpointPersist: async (t) => t(),
        resilienceV2Enabled: false,
      },
      {
        state,
        round: 3,
        response: { content: '我再想想…', role: 'assistant' },
        currentTools: state.tools,
        tokenUsage: { input: 100, output: 50 },
        chatFn: vi.fn(),
        logger: { loopStop: vi.fn(), getEntries: vi.fn(() => []) } as any,
      },
    );

    expect(result.action).toBe('continue');
    expect(bridge.getAccumulatedDeviationSignals().some(s => s.type === 'no_progress')).toBe(true);
  });

  it('casual 意图跳过 L2 after-round', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, {});
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const state = makeState(bridge);
    state.taskState.applySnapshot({
      ...state.taskState.snapshot(),
      goal: '什么是 TypeScript',
      intent: 'question',
    });
    state.consecutiveNoToolRounds = 10;

    const observeSpy = vi.spyOn(bridge, 'observeAfterTools');

    await evaluateSupervisorAfterNoToolRound(
      {
        loopController: new LoopController({ maxRounds: 5 }),
        graphExecutor: new GraphExecutor(),
        workspaceRoot: process.cwd(),
        supervisorBridge: bridge,
        enqueueCheckpointPersist: async (t) => t(),
        resilienceV2Enabled: false,
      },
      {
        state,
        round: 1,
        response: { content: 'TypeScript 是…', role: 'assistant' },
        currentTools: [],
        tokenUsage: { input: 10, output: 10 },
        chatFn: vi.fn(),
        logger: { loopStop: vi.fn(), getEntries: vi.fn(() => []) } as any,
      },
    );

    expect(observeSpy).not.toHaveBeenCalled();
  });
});
