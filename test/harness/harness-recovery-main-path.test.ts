import { describe, it, expect } from 'vitest';
import type { UnifiedMessage } from '../../src/llm/types.js';
import { GraphExecutor } from '../../src/harness/task-graph-executor.js';
import {
  applyTakeoverRecoveryMainPath,
  buildRecoveryExtractInput,
  buildRecoverySummaries,
  resolveRecoveryMainPathSignals,
  shouldRunRecoveryMainPath,
} from '../../src/harness/harness-recovery-main-path.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { TaskState } from '../../src/harness/task-state.js';
import { RepoContext } from '../../src/harness/repo-context.js';
import { VerificationOutputBuffer } from '../../src/harness/verification-output-buffer.js';
import { LoopController } from '../../src/harness/loop-controller.js';
import { resolveSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import { createSupervisorRuntimeBridge } from '../../src/harness/supervisor/supervisor-bridge.js';
import { syncExecutionModeLoopState } from '../../src/harness/supervisor/execution-mode-constraints.js';
import { emptyHarnessPolicyStats } from '../../src/harness/harness-policy-stats.js';

describe('harness-recovery-main-path', () => {
  const criticalTask = {
    goal: 'fix failing tests',
    intent: 'debug' as const,
    domain: 'critical_debug' as const,
    filesChanged: ['src/login.ts'],
    filesRead: ['src/login.ts'],
    commandsRun: ['npm test'],
    recentFailureCount: 3,
    branchBudgetTriggers: 0,
  };

  function makeState(verificationPassed = true): HarnessRunState {
    const taskState = new TaskState('fix failing tests');
    taskState.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/login.ts' } },
      { success: true, output: 'ok' },
    );
    taskState.recordToolResult(
      { id: 't1', name: 'run_command', arguments: { command: 'npm test' } },
      verificationPassed
        ? { success: true, output: 'pass' }
        : { success: false, output: '', error: 'fail' },
    );
    const repoContext = new RepoContext();
    repoContext.recordToolResult(
      { id: 'w1', name: 'edit_file', arguments: { path: 'src/login.ts' } },
      { success: true, output: 'ok' },
    );
    return {
      messages: [],
      tools: [],
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
      verificationGateContinuationCount: 0,
      transition: 'initial',
      justCompacted: false,
      amnesiaRecoveryCount: 0,
      taskState,
      repoContext,
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
      supervisorPhase: 'takeover',
      verificationOutputBuffer: new VerificationOutputBuffer(),
      rebuildEscalationInjections: 0,
      rebuildEscalationInjectedThisRound: false,
      parallelBudgetBlockHintInjected: false,
      segmentRenewalCount: 0,
      consecutiveNoToolRounds: 0,
      missingFileAttempts: new Map(),
      harnessPolicyStats: emptyHarnessPolicyStats(),
      checkpointResumeForkApplied: false,
      contextEmergencyCompactUsed: false,
    };
  }

  function forceTakeover(bridge: ReturnType<typeof createSupervisorRuntimeBridge>): void {
    bridge.recoverySupervisor.commit({
      phase: 'takeover',
      takeoverStartRound: 1,
      stableRoundsInTakeover: 0,
      cooldownRemaining: 0,
    });
  }

  it('shouldRunRecoveryMainPath: takeover decision or handoff_pending reversion', () => {
    expect(shouldRunRecoveryMainPath('free', 'takeover', {
      action: 'takeover',
      reason: 'x',
      signals: [],
    })).toBe(true);
    expect(shouldRunRecoveryMainPath('handoff_pending', 'takeover', { action: 'continue' })).toBe(true);
    expect(shouldRunRecoveryMainPath('takeover', 'takeover', { action: 'continue' })).toBe(false);
    expect(shouldRunRecoveryMainPath('free', 'free', { action: 'continue' })).toBe(false);
  });

  it('buildRecoverySummaries includes verification buffer build failure', () => {
    const state = makeState(false);
    state.verificationOutputBuffer.recordFailed('npm run build', 'Error: TS2304 cannot find name');
    const summaries = buildRecoverySummaries(state);
    expect(summaries.testSummary).toBe('failed');
    expect(summaries.buildSummary).toContain('failed:');
    expect(summaries.buildSummary).toContain('TS2304');
  });

  it('buildRecoveryExtractInput maps task and repo snapshots', () => {
    const state = makeState();
    const input = buildRecoveryExtractInput(state);
    expect(input.task.goal).toBe('fix failing tests');
    expect(input.repo.filesChanged).toContain('src/login.ts');
    expect(input.testSummary).toBe('passed');
  });

  it('replaceGraph on template_graph tier after takeover', () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, {});
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    forceTakeover(bridge);

    const state = makeState();
    const executor = new GraphExecutor();
    const messages: UnifiedMessage[] = [];
    const stepEvents: string[] = [];

    const result = applyTakeoverRecoveryMainPath({
      bridge,
      state,
      task: criticalTask,
      round: { round: 3, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
      graphExecutor: executor,
      messages,
      freshTakeoverEntry: true,
      onStep: (e) => {
        if (e.type === 'task_graph_init') stepEvents.push('task_graph_init');
      },
    });

    expect(result.tier).toBe('template_graph');
    expect(executor.hasGraph()).toBe(true);
    expect(executor.isInTakeover()).toBe(true);
    expect(stepEvents).toEqual(['task_graph_init']);
    expect(state.lastRecoveryExtractRound).toBe(3);
  });

  it('marks forcedDegradedTier and syncs loop controller on strong_hint fallback', () => {
    const config = resolveSupervisorConfig({
      mode: 'adaptive',
      snapshotConfidence: { templateGraphMin: 0.99 },
    }, {});
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    forceTakeover(bridge);

    const state = makeState();
    state.taskState.recordToolResult(
      { id: 't2', name: 'run_command', arguments: { command: 'npm test' } },
      { success: false, output: '', error: 'fail' },
    );
    const executor = new GraphExecutor();
    const loopController = new LoopController({ maxRounds: 20 });
    syncExecutionModeLoopState(loopController, state);

    const result = applyTakeoverRecoveryMainPath({
      bridge,
      state,
      task: criticalTask,
      round: { round: 4, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      signals: [{ type: 'no_progress', rounds: 4 }],
      graphExecutor: executor,
      messages: [],
      loopController,
      freshTakeoverEntry: true,
    });

    expect(result.tier).toBe('strong_hint');
    expect(result.fallbackReason).toBe('low_confidence');
    expect(executor.hasGraph()).toBe(false);
    expect(state.forcedDegradedTier).toBe('step_queue');
    expect(loopController.getState().forcedDegradedTier).toBe('step_queue');
  });

  it('resolveRecoveryMainPathSignals uses bridge accumulation on handoff reversion', () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, {});
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    bridge.passiveObserver.pushSignal({ type: 'no_progress', rounds: 5 });

    const signals = resolveRecoveryMainPathSignals({ action: 'continue' }, bridge);
    expect(signals.some(s => s.type === 'no_progress')).toBe(true);
  });

  it('re-runs main path on handoff_pending → takeover via bridge integration', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, {});
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const { GraphExecutor } = await import('../../src/harness/task-graph-executor.js');
    const executor = new GraphExecutor();
    const state = makeState();

    bridge.recoverySupervisor.commit({
      phase: 'handoff_pending',
      takeoverStartRound: 1,
      stableRoundsInTakeover: 4,
      cooldownRemaining: 0,
    });
    state.supervisorPhase = 'handoff_pending';

    const decision = await bridge.evaluateAfterRound({
      round: { round: 8, toolNames: ['edit_file'], toolSuccess: [false], hadWriteTool: true },
      task: criticalTask,
      riskScore: 0.7,
      extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
    });

    expect(decision.action).toBe('continue');
    expect(bridge.getSupervisorPhase()).toBe('takeover');
    expect(shouldRunRecoveryMainPath('handoff_pending', 'takeover', decision)).toBe(true);

    const result = applyTakeoverRecoveryMainPath({
      bridge,
      state,
      task: criticalTask,
      round: { round: 8, toolNames: ['edit_file'], toolSuccess: [false], hadWriteTool: true },
      signals: resolveRecoveryMainPathSignals(decision, bridge),
      graphExecutor: executor,
      freshTakeoverEntry: false,
    });

    expect(result.tier).toBe('template_graph');
    expect(executor.hasGraph()).toBe(true);
  });

  it('shadow evaluate 返回 continue 时不应跑主路径', async () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', shadow: true },
      { ICE_SUPERVISOR_SHADOW: '1' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    expect(bridge.globalPolicy.shadow).toBe(true);

    bridge.observeAfterTools({
      phase: 'free',
      round: { round: 1, toolNames: ['edit_file'], toolSuccess: [false], hadWriteTool: true },
      consecutiveToolFailures: 3,
      consecutiveReadOnlyRounds: 0,
      consecutiveNoToolRounds: 0,
      stableRoundsSinceLastFailure: 0,
      allToolsFailedThisRound: true,
      repeatedToolSignatures: ['edit_file:src/login.ts'],
      maxFailedSignatureCount: 3,
      branchRecoverTriggered: false,
      task: criticalTask,
    });

    const decision = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: ['edit_file'], toolSuccess: [false], hadWriteTool: true },
      task: criticalTask,
      riskScore: 0.7,
    });

    expect(decision.action).toBe('continue');
    expect(bridge.getSupervisorPhase()).toBe('free');
    expect(shouldRunRecoveryMainPath('free', bridge.getSupervisorPhase(), decision)).toBe(false);
  });
});
