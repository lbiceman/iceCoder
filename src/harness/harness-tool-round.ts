import type { LLMResponse, ToolDefinition } from '../llm/types.js';
import { buildTotalTokenUsageWithContext } from './context-usage-display.js';
import type { CheckpointDeps } from './harness-checkpoint.js';
import { recordTelemetrySummary, saveTaskCheckpoint } from './harness-checkpoint.js';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  FAILURE_EVIDENCE_THRESHOLD_END,
  FAILURE_EVIDENCE_THRESHOLD_START,
  LIGHT_HINT_FAILURE_THRESHOLD_END,
  LIGHT_HINT_FAILURE_THRESHOLD_START,
  MAX_REBUILD_ESCALATIONS_PER_RUN,
  STRONG_WARNING_FAILURE_THRESHOLD,
} from './harness-constants.js';
import {
  buildFailureEvidencePackMessage,
  buildLightFailureHintMessage,
  buildStrongFailureWarningMessage,
  collectFailureEvidenceEntries,
  purgeEphemeralFailureRecoveryMessagesInPlace,
  roundHadSuccessfulVerification,
  type EphemeralFailureRecoveryKind,
} from './failure-evidence-recovery.js';
import type { ResilienceBridgeDeps } from './harness-resilience.js';
import {
  resilienceMaybeBranchRecover,
  resilienceMaybeReviewStep,
  resilienceRecordToolCalls,
  resilienceSaveCheckpoint,
} from './harness-resilience.js';
import { collectRepeatedFailures, toolCallSignature } from './harness-permission-runtime.js';
import { stripEmbeddedToolCalls, prepareAssistantContentForHistory } from './text-tool-call-salvage.js';
import type { HarnessRunState } from './harness-run-state.js';
import { syncTaskVerificationFromAcceptance } from './incomplete-completion.js';
import { classifyRunCommandResult } from './task-acceptance-tracker.js';
import type { StopHandlerDeps } from './harness-stop-handler.js';
import { handleHarnessStop } from './harness-stop-handler.js';
import type { ToolExecutorDeps } from './harness-tool-executor.js';
import { executeToolCallsStreaming } from './harness-tool-executor.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type { GraphExecutor } from './task-graph-executor.js';
import {
  normalizeGraphHintInput,
  type ComposeGraphHintArgs,
} from './supervisor/mode-gating.js';
import type { HarnessMemoryIntegration } from './harness-memory.js';
import type { TokenBudgetTracker } from './token-budget.js';
import type { CorrectionPort, CorrectionSource, ExecutionModeConfig, GateContext, TaskRiskLevel } from '../types/supervisor.js';
import type { TaskGraphSnapshot } from '../types/task-graph.js';
import {
  markForcedDegraded,
  recordTaskBearingRoundIfForced,
  syncExecutionModeLoopState,
} from './supervisor/execution-mode-constraints.js';
import { MessageCorrectionPort } from './supervisor/correction-port.js';
import { executeToolCallsThroughGate } from './supervisor/tool-gate.js';
import { computeForcedDegradedTier } from './supervisor/forced-degraded.js';
import { decideGraphHintRouting, type GraphHintRoutingDecision } from './supervisor/graph-hint-routing.js';
import type { SupervisorRuntimeBridge } from './supervisor/supervisor-bridge.js';
import { topFileEditFromInspect } from './supervisor/passive-observer.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import { extractRunCommand } from './branch-budget-tool-path.js';
import { computeRecoveryRoundEffective, classifyToolRoundProgress } from './recovery-round-progress.js';
import {
  buildVerificationDigest,
  isHarnessVerificationCommand,
  resolveVerificationSuccessSummary,
} from './verification-digest.js';
import { resolveCheckpointUserGoal } from './session-goal-anchor.js';
import { maybeResetVerificationGateCounter } from './harness-verification-gate.js';
import {
  buildDiagnosticGateMessage,
  shouldActivateBuildDiagnosticGate,
  shouldClearBuildDiagnosticGate,
} from './harness-tool-preflight.js';
import {
  planTruncatedWriteToolRecovery,
  shouldPlanTruncatedWriteToolRecovery,
} from './harness-tool-truncation-recovery.js';
import { evaluateSupervisorAfterRound } from './harness-supervisor-round.js';
import { tryInjectRebuildEscalation } from './harness-rebuild-inject.js';
import {
  shouldInjectParallelBudgetBlockHint,
  shouldTriggerAnyFileCapRebuild,
  type RebuildEscalationTrigger,
} from './rebuild-escalation.js';
import type {
  ChatFunction,
  HarnessResult,
  HarnessStepEvent,
  StreamFunction,
} from './types.js';

export interface ToolRoundDeps
  extends Omit<ToolExecutorDeps, 'workspaceRoot'>,
    CheckpointDeps,
    ResilienceBridgeDeps,
    StopHandlerDeps {
  workspaceRoot: string;
  loopController: LoopController;
  memoryIntegration: HarnessMemoryIntegration;
  graphExecutor: GraphExecutor;
  executionModeConfig?: ExecutionModeConfig;
  executionModeDecisionEnabled?: boolean;
  supervisorBridge?: SupervisorRuntimeBridge;
  /**
   * L2-6 — Harness 主循环侧 RiskClassifier 结果回放器。
   *
   * 实现挂在 Harness 上：将 before-LLM 已经算过的 TaskRiskLevel 映射到 0..1 的 riskScore（与
   * §8.10 / `adaptiveFree.riskThreshold` 同标尺），供 bridge.evaluateAfterRound 复用，避免在
   * after-round 再算一次。缺省时退回 0.5 中性值（adaptive 默认阈值 0.6，不直接进入候选）。
   */
  supervisorRiskScoreProvider?: () => number;
  /** L2-6 — 任务级 token 总预算，用于 `RecoveryBudgetManager.recordTokenUsage`。 */
  tokenBudgetTracker?: TokenBudgetTracker;
  /** 单次 LLM max_tokens 上限（与 adapter 对齐，供 write 截断检测）。 */
  agentMaxOutputTokens?: number;
  abortSignal?: AbortSignal;
}

const TASK_BEARING_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'batch_edit_file', 'patch_file']);

export interface RunHarnessToolRoundArgs {
  state: HarnessRunState;
  response: LLMResponse;
  userMessage: string;
  currentTools: ToolDefinition[];
  round: number;
  tokenUsage: { input: number; output: number };
  chatFn: ChatFunction;
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
  streamFn?: StreamFunction;
}

export type RunHarnessToolRoundResult =
  | { action: 'continue' }
  | { action: 'return'; result: HarnessResult };

/**
 * 有工具调用时：执行工具、resilience、熔断、任务图、记忆注入、循环控制。
 */
export async function runHarnessToolRound(
  deps: ToolRoundDeps,
  args: RunHarnessToolRoundArgs,
): Promise<RunHarnessToolRoundResult> {
  const {
    state,
    response,
    userMessage,
    currentTools,
    round,
    tokenUsage,
    chatFn,
    logger,
    onStep,
    streamFn,
  } = args;

  const msgs = state.messages;

  if (state.justCompacted) state.justCompacted = false;

  onStep?.({
    type: 'thinking',
    iteration: round,
    content: prepareAssistantContentForHistory(response.content) || undefined,
    tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
    totalTokenUsage: buildTotalTokenUsageWithContext(msgs, currentTools, {
      lastInputTokens: deps.loopController.getState().lastInputTokens,
      lastOutputTokens: deps.loopController.getState().lastOutputTokens,
    }),
  });

  msgs.push({
    role: 'assistant',
    content: prepareAssistantContentForHistory(response.content || ''),
    toolCalls: response.toolCalls,
  });

  let toolCallsForGate = response.toolCalls ?? [];
  if (shouldPlanTruncatedWriteToolRecovery({
    toolCalls: toolCallsForGate,
    finishReason: response.finishReason,
    outputTokens: tokenUsage.output,
    maxOutputTokens: deps.agentMaxOutputTokens,
  })) {
    const recovery = planTruncatedWriteToolRecovery(toolCallsForGate);
    msgs.push(...recovery.injectedMessages);
    toolCallsForGate = recovery.toolCallsToRun;
    if (toolCallsForGate.length === 0) {
      return { action: 'continue' };
    }
  }

  state.branchBudgetWarnedThisRound = false;
  state.stepReviewedThisRound = false;
  state.verificationDigestInjectedThisRound = false;
  state.rebuildEscalationInjectedThisRound = false;
  state.branchBudget?.resetRoundBudget();

  deps.branchBudget = state.branchBudget;
  deps.missingFileAttempts = state.missingFileAttempts;
  deps.harnessPolicyStats = state.harnessPolicyStats;
  state.branchBudget?.bindWorkspaceRoot(deps.workspaceRoot);

  // L2-6 / I4：bridge 活跃时由 bridge 工厂创建挂 budget 的端口；off 时退回普通 port。
  //          所有 free 段 recovery / graph_hint 类 inject 都经此端口，统一受 freeSegmentMaxPerTask 约束。
  const correctionPort: CorrectionPort = deps.supervisorBridge?.isActive()
    ? deps.supervisorBridge.createCorrectionPort(msgs, round)
    : new MessageCorrectionPort(msgs);
  const graphSnapshotBefore = deps.graphExecutor?.toSnapshot();
  const gateContext = buildGateContext(deps.graphExecutor, toolCallsForGate, state);
  const gateResult = executeToolCallsThroughGate({
    toolCalls: toolCallsForGate,
    messages: msgs,
    ctx: gateContext,
  });
  const executableToolCalls = gateResult.executableToolCalls;
  const blockedToolSignatures = gateResult.skippedSignatures;
  // W5: gate 决策已用 buildGateContext (track:false) 完成；这里只对真正会执行的
  //     工具补一次 track:true 的 checkToolCall（推 currentRoundToolNames），
  //     blocked 的工具不入 DeviationDetector，避免同名计数翻倍 / 误升级。
  //     warn 文案直接复用 gateContext.graphHints，不再二次判定。
  if (gateContext.executionMode === 'forced' && deps.graphExecutor?.hasGraph()) {
    for (const tc of executableToolCalls) {
      deps.graphExecutor.checkToolCall(tc.name, { track: true });
      const hint = gateContext.graphHints.find(h => h.toolName === tc.name);
      if (hint?.action === 'warn' && hint.message) {
        composeGraphHint(deps, {
          round,
          executionMode: gateContext.executionMode,
          port: correctionPort,
          phase: gateContext.phase,
          input: { origin: 'forced_step', kind: 'warn', message: hint.message },
        });
      }
    }
    if (executableToolCalls.length === 0 && response.toolCalls?.length) {
      composeGraphHint(deps, {
        round,
        executionMode: gateContext.executionMode,
        port: correctionPort,
        phase: gateContext.phase,
        input: {
          origin: 'forced_step',
          kind: 'block',
          message: '[ToolGate] All tool calls were blocked by the current forced step gate. Choose a valid tool for the active step.',
        },
      });
    }
  }

  const acceptancePendingBefore = state.taskAcceptance?.isActive()
    ? state.taskAcceptance.getPendingCount()
    : 0;
  const pendingDeliverablesBefore = state.taskState.pendingFileDeliverableCount(deps.workspaceRoot);
  state.taskState.reconcileOrphanFileDeliverableWriteVersions(deps.workspaceRoot);

  const repoFilesChangedBefore = state.repoContext.snapshot().filesChanged.length;
  const toolStats = await executeToolCallsStreaming(deps, {
    toolCalls: executableToolCalls,
    messages: msgs,
    logger,
    onStep,
    harnessAbortSignal: deps.abortSignal,
    taskState: state.taskState,
    repoContext: state.repoContext,
    chatFn,
    currentTools,
    buildDiagnosticGateActive: state.buildDiagnosticGateActive,
    verificationOutputBuffer: state.verificationOutputBuffer,
  });
  if (executableToolCalls.length > 0) {
    state.consecutiveNoToolRounds = 0;
    const acceptanceIncompleteAfter = Boolean(
      state.taskAcceptance?.isActive() && !state.taskAcceptance.isComplete(),
    );
    const acceptancePendingAfter = state.taskAcceptance?.isActive()
      ? state.taskAcceptance.getPendingCount()
      : 0;
    const pendingDeliverablesAfter = state.taskState.pendingFileDeliverableCount(deps.workspaceRoot);
    const blockingAfter = state.taskState.isVerificationBlockingFinal(
      acceptanceIncompleteAfter,
      deps.workspaceRoot,
    );
    maybeResetVerificationGateCounter(
      state,
      pendingDeliverablesBefore,
      pendingDeliverablesAfter,
      blockingAfter,
      acceptancePendingBefore,
      acceptancePendingAfter,
    );
  }
  // P0-A — acceptance gate / verification buffer：按工具结果**真实状态**而非「启动成功」判定。
  //   - 后台启动 (`mode:'background'|'escalated'`) → acceptance 状态保持 pending
  //   - check 返回 `status:'completed' && exitCode:0` → mark passed
  //   - check 返回 `status:'failed'|'timeout'|'killed'` 或 exitCode≠0 → mark failed + 回写 verificationOutputBuffer
  // P1 — 验收项首次从 pending → passed 时对称注入 `[System / Acceptance ✓]` 反馈，
  //       全部 passed 时再追加一条 stopping signal，让模型有客观信号决定收尾。
  const newlyPassedAcceptance: Array<{ command: string; summary: string | null }> = [];
  let acceptanceJustCompletedAll = false;
  if (executableToolCalls.length > 0) {
    const acceptanceActive = state.taskAcceptance?.isActive();
    const wasCompleteBefore = state.taskAcceptance?.isComplete() ?? false;
    for (const tc of executableToolCalls) {
      if (tc.name !== 'run_command') continue;
      const sig = toolCallSignature(tc);
      const success = !toolStats.failedSignatures.includes(sig)
        && !toolStats.policyBlockedSignatures.includes(sig);
      const toolMsg = msgs.find(m => m.role === 'tool' && m.toolCallId === tc.id);
      const rawOutput = typeof toolMsg?.content === 'string' ? toolMsg.content : '';
      const classified = classifyRunCommandResult(tc.arguments as Record<string, unknown>, rawOutput, success);
      if (!classified) continue;

      if (acceptanceActive && state.taskAcceptance) {
        const transition = state.taskAcceptance.recordRunCommandToolResult(classified);
        if (transition
          && transition.newStatus === 'passed'
          && transition.previousStatus !== 'passed') {
          const summary = resolveVerificationSuccessSummary(
            classified.command,
            rawOutput,
            tc.arguments as Record<string, unknown>,
          );
          newlyPassedAcceptance.push({ command: transition.command, summary });
        }
      }

      if (classified.kind === 'background_failed'
        && isHarnessVerificationCommand(classified.command)
        && state.verificationOutputBuffer) {
        state.verificationOutputBuffer.recordFailed(classified.command, rawOutput);
      }
    }
    if (acceptanceActive && state.taskAcceptance) {
      syncTaskVerificationFromAcceptance(state.taskState, state.taskAcceptance);
      if (!wasCompleteBefore && state.taskAcceptance.isComplete()) {
        acceptanceJustCompletedAll = true;
      }
    }
  }
  const failedSignaturesForSignals = new Set(toolStats.failedSignatures);
  // tool_failure 信号：本轮任意可执行工具 success:false 即提交（常见为 run_command/npm test 验收失败，
  // 其次 BranchBudget 拦 write/edit，较少为 patch 对不上等真工具错误）。UI「forced · 工具失败」
  // 是 enter_forced 主因标签，不表示 edit 工具坏了；详见 branch-budget.ts 文件头运维说明。
  if (deps.executionModeConfig && toolStats.failedCount > 0) {
    state.submitModeSignal?.('step_gate', 'tool_failure', { failedCount: toolStats.failedCount });
  }
  if (deps.executionModeConfig) {
    const writeTargetsThisRound = countWriteTargets(executableToolCalls, failedSignaturesForSignals);
    if (writeTargetsThisRound > deps.executionModeConfig.writeTargetsEnterThreshold) {
      state.submitModeSignal?.('step_gate', 'multi_write', { writeTargetsThisRound });
    }
  }

  await resilienceRecordToolCalls(
    deps,
    executableToolCalls,
    new Set(toolStats.failedSignatures),
    new Set(toolStats.policyBlockedSignatures),
    state,
    deps.workspaceRoot,
  );

  state.branchBudget?.bindWorkspaceRoot(deps.workspaceRoot);

  // cleanup/删除命令执行后，从 filesChanged 剔除已不存在的路径，避免下轮 Gate 要求重读
  state.taskState.reconcileMissingChangedFiles(deps.workspaceRoot);
  state.repoContext.reconcileMissingChangedFiles(deps.workspaceRoot);

  maybeInjectParallelBudgetBlockHint({
    state,
    msgs,
    correctionPort,
    deps,
    executableToolCalls,
    policyBlockedSignatures: toolStats.policyBlockedSignatures,
    budgetBlockedFilePaths: toolStats.budgetBlockedFilePaths,
  });

  maybeInjectVerificationDigest({
    state,
    msgs,
    executableToolCalls,
    failedSignatures: toolStats.failedSignatures,
    correctionPort,
    deps,
  });

  maybeInjectAcceptanceSuccessFeedback({
    state,
    msgs,
    correctionPort,
    deps,
    newlyPassed: newlyPassedAcceptance,
    completedAll: acceptanceJustCompletedAll,
  });

  maybeUpdateBuildDiagnosticGate(state, msgs, executableToolCalls, toolStats, correctionPort, deps);

  maybeInjectFileCapRebuildEscalation({
    state,
    msgs,
    correctionPort,
    deps,
  });

  const repeatedFailures = collectRepeatedFailures(
    executableToolCalls,
    toolStats.failedSignatures,
    state.failedToolCallSignatures,
  );
  if (repeatedFailures.length > 0) {
    injectToolFailureEscalation(
      deps,
      state,
      msgs,
      correctionPort,
      `[System] Repeated failed tool call detected: ${repeatedFailures.join(', ')}. Do not retry the same tool with the same arguments. Change the path, parameters, command, or use a different tool; if blocked, explain the exact blocker and evidence.`,
      { preserveOnCompaction: true },
    );
  }

  const branchRecoverDecision = state.branchBudget?.shouldBranchRecover();
  resilienceMaybeBranchRecover(
    deps,
    state,
    msgs,
    deps.executionModeDecisionEnabled && !deps.supervisorObserverSuppressInject
      ? correctionPort
      : undefined,
  );

  // P2 — 用户中断早退：在可能调用 LLM 的 reviewStep / checkpoint 之前先检查 isAborted。
  // 命中则跳过 resilience review (可能再发一次小模型请求) 与 verification_failed checkpoint。
  if (deps.loopController.isAborted()) {
    return {
      action: 'return',
      result: await handleHarnessStop(deps, {
        reason: 'user_abort',
        messages: msgs,
        chatFn,
        tools: currentTools,
        logger,
        onStep,
        streamFn,
        runtimeState: state,
      }),
    };
  }

  if (toolStats.failedCount > 0) {
    await resilienceMaybeReviewStep(
      deps,
      state,
      'tool_failure',
      chatFn,
      deps.executionModeDecisionEnabled ? correctionPort : undefined,
    );
  }

  if (state.taskState.snapshot().verificationStatus === 'failed') {
    await resilienceSaveCheckpoint(deps, 'verification_failed', state);
    if (!state.stepReviewedThisRound) {
      await resilienceMaybeReviewStep(
        deps,
        state,
        'verification_failure',
        chatFn,
        deps.executionModeDecisionEnabled ? correctionPort : undefined,
      );
    }
  }

  if (deps.loopController.isAborted()) {
    return {
      action: 'return',
      result: await handleHarnessStop(deps, {
        reason: 'user_abort',
        messages: msgs,
        chatFn,
        tools: currentTools,
        logger,
        onStep,
        streamFn,
        runtimeState: state,
      }),
    };
  }

  const roundProgress = classifyToolRoundProgress({
    executableToolCalls,
    failedSignatures: toolStats.failedSignatures,
    policyBlockedSignatures: toolStats.policyBlockedSignatures,
    branchBudget: state.branchBudget,
  });

  if (roundProgress === 'all_failed_or_blocked') {
    state.consecutiveToolFailures++;
    // W1: 本轮全失败 → 重置 stable 计数；evaluate 才能正确判定"连续 N 轮稳定"。
    state.stableRoundsSinceLastFailure = 0;
    const failureCount = state.consecutiveToolFailures;

    if (failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
      console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，触发熔断`);
      deps.loopController.stop('circuit_breaker');
      const finalState = deps.loopController.getState();
      logger.loopStop('circuit_breaker', finalState.currentRound, finalState.totalToolCalls);
      await saveTaskCheckpoint(deps, 'failed', resolveCheckpointUserGoal(state, userMessage), msgs, state, 'circuit_breaker');
      recordTelemetrySummary(deps, 'circuit_breaker', state);

      onStep?.({
        type: 'final',
        iteration: finalState.currentRound,
        totalToolCalls: finalState.totalToolCalls,
        content: `${failureCount} consecutive rounds of tool calls failed, circuit breaker triggered.`,
        stopReason: 'circuit_breaker',
      });

      return {
        action: 'return',
        result: {
          content: `${failureCount} consecutive rounds of tool calls failed, circuit breaker triggered. The last errors have been logged; please check tool configuration or environment and retry.`,
          loopState: finalState,
          messages: [...msgs],
          log: logger.getEntries(),
        },
      };
    }

    if (failureCount >= STRONG_WARNING_FAILURE_THRESHOLD) {
      purgeEphemeralFailureRecoveryMessagesInPlace(msgs);
      injectEphemeralFailureRecovery(
        deps,
        state,
        msgs,
        correctionPort,
        buildStrongFailureWarningMessage(failureCount),
        'strong',
      );
      console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，注入强警告`);
    } else if (
      failureCount >= FAILURE_EVIDENCE_THRESHOLD_START
      && failureCount <= FAILURE_EVIDENCE_THRESHOLD_END
    ) {
      purgeEphemeralFailureRecoveryMessagesInPlace(msgs, 'light');
      purgeEphemeralFailureRecoveryMessagesInPlace(msgs, 'evidence');
      const entries = collectFailureEvidenceEntries(msgs, state.verificationOutputBuffer);
      injectEphemeralFailureRecovery(
        deps,
        state,
        msgs,
        correctionPort,
        buildFailureEvidencePackMessage(failureCount, entries),
        'evidence',
      );
      console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，注入失败证据包`);
    } else if (
      failureCount >= LIGHT_HINT_FAILURE_THRESHOLD_START
      && failureCount <= LIGHT_HINT_FAILURE_THRESHOLD_END
    ) {
      injectEphemeralFailureRecovery(
        deps,
        state,
        msgs,
        correctionPort,
        buildLightFailureHintMessage(failureCount),
        'light',
      );
      console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，注入轻提示`);
    }
  } else if (roundProgress === 'meaningful_progress') {
    state.consecutiveToolFailures = 0;
    state.stopHookContinuationCount = 0;
    state.stableRoundsSinceLastFailure = (state.stableRoundsSinceLastFailure ?? 0) + 1;
    purgeEphemeralFailureRecoveryMessagesInPlace(msgs);
    if (roundHadSuccessfulVerification(executableToolCalls, toolStats.failedSignatures)) {
      state.verificationOutputBuffer.clear();
    }
  } else {
    // 只读空转（如读已有 src 模板）：不清零 consecutiveToolFailures，避免熔断/续段永远达不到阈值。
    state.stableRoundsSinceLastFailure = 0;
  }

  let evalForceSwitchTriggered = false;
  if (deps.graphExecutor?.hasGraph() && executableToolCalls.length > 0) {
    for (const tc of executableToolCalls) {
      const sig = toolCallSignature(tc);
      const success = !toolStats.failedSignatures.includes(sig);
      deps.graphExecutor.recordToolResult(tc.name, success);
    }
    const evalResult = deps.graphExecutor.evaluateRound(executableToolCalls.length);
    const routing = composeGraphHint(deps, {
      round,
      executionMode: gateContext.executionMode,
      port: correctionPort,
      phase: state.supervisorPhase,
      input: {
        origin: 'evaluate_round',
        action: evalResult.action,
        message: evalResult.message,
      },
    });
    if (evalResult.action === 'force_switch') {
      evalForceSwitchTriggered = true;
      if (routing.emitTelemetry) {
        onStep?.({ type: 'task_graph_branch', reason: 'fallback_activated', message: evalResult.message });
      }
    }

    const syncResult = deps.graphExecutor.syncCursorToTaskPhase(state.taskState.snapshot().phase);
    if (syncResult.changed && syncResult.view) {
      onStep?.({
        type: 'task_graph_update',
        plan: syncResult.view,
        nodeId: syncResult.nodeId,
        nodeIndex: syncResult.nodeIndex,
        graphStatus: deps.graphExecutor.toSnapshot()?.status,
      });
    }
  }
  const graphSnapshotAfter = deps.graphExecutor?.toSnapshot();

  if (gateContext.executionMode === 'forced') {
    const plannedToolCount = response.toolCalls?.length ?? 0;
    const plannedHadWriteTool = response.toolCalls?.some(tc => TASK_BEARING_WRITE_TOOLS.has(tc.name)) ?? false;
    const tier = computeForcedDegradedTier({
      executionMode: 'forced',
      graphInitFailed: false,
      forceSwitchTriggered: evalForceSwitchTriggered,
      plannedToolCount,
      executableToolCount: executableToolCalls.length,
      plannedHadWriteTool,
    });
    if (tier) markForcedDegraded(state, tier);
  }

  if (deps.executionModeConfig) {
    const failedSignatures = new Set(toolStats.failedSignatures);
    const successfulExecutableCalls = executableToolCalls.filter(tc => {
      const sig = toolCallSignature(tc);
      return !failedSignatures.has(sig) && !blockedToolSignatures.has(sig);
    });
    const hadSuccessfulToolExecute = toolStats.totalCount > toolStats.failedCount
      && successfulExecutableCalls.length > 0;
    const writeToolSucceeded = executableToolCalls.some(tc => (
      TASK_BEARING_WRITE_TOOLS.has(tc.name)
        && !failedSignatures.has(toolCallSignature(tc))
        && !blockedToolSignatures.has(toolCallSignature(tc))
    )) && toolStats.totalCount > toolStats.failedCount;
    const repoFilesChangedAfter = state.repoContext.snapshot().filesChanged.length;
    recordTaskBearingRoundIfForced(state, {
      hadSuccessfulToolExecute,
      graphStepAdvanced: didGraphStepAdvance(graphSnapshotBefore, graphSnapshotAfter),
      writeToolSucceededWithFileChange: writeToolSucceeded && repoFilesChangedAfter > repoFilesChangedBefore,
    }, deps.executionModeConfig);
    syncExecutionModeLoopState(deps.loopController, state);
  }

  await saveTaskCheckpoint(deps, 'running', resolveCheckpointUserGoal(state, userMessage), msgs, state);
  await resilienceSaveCheckpoint(deps, 'step_completed', state);

  onStep?.({
    type: 'context_usage',
    iteration: round,
    totalTokenUsage: buildTotalTokenUsageWithContext(msgs, currentTools, {
      lastInputTokens: deps.loopController.getState().lastInputTokens,
      lastOutputTokens: deps.loopController.getState().lastOutputTokens,
    }),
  });

  const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'patch_file', 'run_command']);
  const hadWriteTool = executableToolCalls.some(tc => WRITE_TOOLS.has(tc.name));
  if (hadWriteTool) {
    state.consecutiveReadOnlyRounds = 0;
  } else if (executableToolCalls.length) {
    state.consecutiveReadOnlyRounds++;
    if (state.consecutiveReadOnlyRounds === 5 && !deps.supervisorObserverSuppressInject) {
      correctionPort.inject(
        {
          kind: 'recovery',
          content: '[System] You have been reading/analyzing for 5 rounds without making any edits. If you have enough context, start implementing changes now using write/edit tools. Do not read more files unless absolutely necessary.',
          preserveOnCompaction: true,
        },
        { phase: state.supervisorPhase, source: 'lifecycle' },
      );
    }
  }

  const allToolsFailedThisRound = roundProgress === 'all_failed_or_blocked';
  const supervisorResult = await evaluateSupervisorAfterRound(deps, {
    state,
    round,
    currentTools,
    tokenUsage,
    chatFn,
    logger,
    onStep,
    streamFn,
    toolNames: executableToolCalls.map(tc => tc.name),
    toolSuccess: executableToolCalls.map(tc => {
      const sig = toolCallSignature(tc);
      return !toolStats.failedSignatures.includes(sig)
        && !toolStats.policyBlockedSignatures.includes(sig);
    }),
    hadWriteTool: executableToolCalls.some(tc => TASK_BEARING_WRITE_TOOLS.has(tc.name)),
    allToolsFailedThisRound,
    repeatedToolSignatures: repeatedFailures,
    branchRecoverTriggered: branchRecoverDecision?.triggered === true,
    recoveryRoundEffective: computeRecoveryRoundEffective({
      executableToolCalls,
      failedSignatures: toolStats.failedSignatures,
      policyBlockedSignatures: toolStats.policyBlockedSignatures,
      branchBudget: state.branchBudget,
    }),
    lastAssistantText: typeof response.content === 'string' ? response.content : undefined,
  });
  if (supervisorResult.action === 'return') {
    return supervisorResult;
  }

  await deps.memoryIntegration.injectMemoryContext(msgs, { onStep });

  const nextStop = deps.loopController.shouldContinue();
  if (nextStop) {
    return {
      action: 'return',
      result: await handleHarnessStop(deps, {
        reason: nextStop,
        messages: msgs,
        chatFn,
        tools: currentTools,
        logger,
        onStep,
        streamFn,
        runtimeState: state,
      }),
    };
  }

  state.maxOutputTokensRecoveryCount = 0;
  state.llmRetryCount = 0;
  state.emptyResponseRetryCount = 0;
  state.transition = 'tool_calls';

  return { action: 'continue' };
}

function didGraphStepAdvance(
  before: TaskGraphSnapshot | null | undefined,
  after: TaskGraphSnapshot | null | undefined,
): boolean {
  if (!before || !after) return false;
  return before.cursor.nodeId !== after.cursor.nodeId
    || before.cursor.nodeIndex !== after.cursor.nodeIndex
    || before.cursor.completedNodeIds.length !== after.cursor.completedNodeIds.length;
}

function buildGateContext(
  graphExecutor: GraphExecutor | undefined,
  toolCalls: LLMResponse['toolCalls'],
  state: HarnessRunState,
): GateContext {
  const executionMode = state.executionMode ?? 'free';
  const graphHints: GateContext['graphHints'] = [];

  if (executionMode === 'forced' && graphExecutor?.hasGraph() && toolCalls) {
    for (const tc of toolCalls) {
      const check = graphExecutor.checkToolCall(tc.name, { track: false });
      graphHints.push({ toolName: tc.name, action: check.action, message: check.message });
    }
  }

  return {
    phase: state.supervisorPhase,
    mode: 'adaptive',
    executionMode,
    graphHints,
  };
}

/**
 * L2-7 / §14.0 — graph hint 收口：bridge 活跃时全部经 `bridge.composeGraphHint`（含 timeline）；
 * bridge 缺省（off 或未注入）时回退到 `decideGraphHintRouting` + 原 inject 行为，保 off 兼容。
 * 任意来源（forced step warn / forced step block / evaluateRound）调用同一入口，避免 free 段
 * 旁路直写 graph_hint。
 */
function composeGraphHint(
  deps: ToolRoundDeps,
  args: ComposeGraphHintArgs,
): GraphHintRoutingDecision {
  if (deps.supervisorBridge) {
    return deps.supervisorBridge.composeGraphHint(args);
  }

  const { message, action } = normalizeGraphHintInput(args.input);
  const routing = decideGraphHintRouting({
    executionMode: args.executionMode,
    action,
    message,
  });
  if (routing.injectToCorrectionPort && message) {
    args.port.inject(
      { kind: 'graph_hint', content: message },
      { phase: args.phase, source: 'supervisor', round: args.round },
    );
  }
  return routing;
}

function maybeInjectFileCapRebuildEscalation(args: {
  state: HarnessRunState;
  msgs: HarnessRunState['messages'];
  correctionPort: CorrectionPort;
  deps: ToolRoundDeps;
}): void {
  const { state, msgs, correctionPort, deps } = args;
  if (deps.supervisorObserverSuppressInject) return;

  const shouldTrigger = shouldTriggerAnyFileCapRebuild({
    branchBudget: state.branchBudget,
    verificationStatus: state.taskState.snapshot().verificationStatus,
    workspaceRoot: deps.workspaceRoot,
    rebuildEscalationInjections: state.rebuildEscalationInjections,
  });
  if (!shouldTrigger) return;

  injectRebuildEscalation(
    deps,
    state,
    msgs,
    correctionPort,
    state.consecutiveToolFailures,
    shouldTrigger.trigger,
  );
  console.log(
    shouldTrigger.trigger === 'missing_file_budget_mismatch'
      ? '[harness] 文件编辑达上限但磁盘无文件，注入整文件创建提示'
      : '[harness] 文件编辑达上限且验收仍失败，注入整文件重建提示',
  );
}

function injectRebuildEscalation(
  deps: ToolRoundDeps,
  state: HarnessRunState,
  msgs: HarnessRunState['messages'],
  correctionPort: CorrectionPort,
  failureCount: number,
  trigger: RebuildEscalationTrigger,
): void {
  tryInjectRebuildEscalation(
    {
      workspaceRoot: deps.workspaceRoot,
      supervisorObserverSuppressInject: deps.supervisorObserverSuppressInject,
      executionModeDecisionEnabled: deps.executionModeDecisionEnabled,
    },
    state,
    msgs,
    correctionPort,
    failureCount,
    trigger,
  );
  if (trigger === 'consecutive_failures') {
    console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，注入整文件重建提示`);
  }
}

function maybeInjectParallelBudgetBlockHint(args: {
  state: HarnessRunState;
  msgs: HarnessRunState['messages'];
  correctionPort: CorrectionPort;
  deps: ToolRoundDeps;
  executableToolCalls: import('../llm/types.js').ToolCall[];
  policyBlockedSignatures: string[];
  budgetBlockedFilePaths: string[];
}): void {
  const {
    state,
    msgs,
    correctionPort,
    deps,
    executableToolCalls,
    policyBlockedSignatures,
    budgetBlockedFilePaths,
  } = args;

  const blocked = new Set(policyBlockedSignatures);
  const blockedWriteTools = executableToolCalls.filter(tc =>
    blocked.has(toolCallSignature(tc))
    && /^(write_file|edit_file|append_file|patch_file|batch_edit_file)$/.test(tc.name),
  );

  if (!shouldInjectParallelBudgetBlockHint({
    parallelBudgetBlockHintInjected: state.parallelBudgetBlockHintInjected,
    budgetBlockedFilePathCount: budgetBlockedFilePaths.length,
    blockedWriteToolCount: blockedWriteTools.length,
    suppressInject: deps.supervisorObserverSuppressInject,
  })) return;

  const paths = budgetBlockedFilePaths.slice(0, 6);
  injectRecoveryMessage(
    deps,
    state,
    msgs,
    correctionPort,
    [
      '[System / BranchBudget] Multiple write/edit tools were blocked in one round (file edit cap).',
      `Blocked paths: ${paths.map(p => `\`${p}\``).join(', ')}.`,
      'Do NOT retry all capped files in parallel. Pick ONE path per round:',
      '1. read failing test / build output first',
      '2. If [Rebuild Escalation] granted write bypass, use write_file on ONE bypass path only',
      '3. Re-run verification before touching the next capped file',
    ].join('\n'),
  );
  state.parallelBudgetBlockHintInjected = true;
}

function maybeInjectVerificationDigest(args: {
  state: HarnessRunState;
  msgs: HarnessRunState['messages'];
  executableToolCalls: import('../llm/types.js').ToolCall[];
  failedSignatures: string[];
  correctionPort: CorrectionPort;
  deps: ToolRoundDeps;
}): void {
  const {
    state,
    msgs,
    executableToolCalls,
    failedSignatures,
    correctionPort,
    deps,
  } = args;

  if (state.verificationDigestInjectedThisRound || deps.supervisorObserverSuppressInject) return;
  if (!state.branchBudget) return;

  const failed = new Set(failedSignatures);
  for (const tc of executableToolCalls) {
    if (tc.name !== 'run_command') continue;
    if (!failed.has(toolCallSignature(tc))) continue;

    const command = extractRunCommand(tc.arguments);
    if (!command || !isHarnessVerificationCommand(command)) continue;

    const retries = state.branchBudget.inspect().commandRetries;
    const normalized = command.trim().replace(/\s+/g, ' ').slice(0, 200);
    const failCount = retries[normalized] ?? 0;
    if (failCount < 1) continue;

    const toolMsg = msgs.find(m => m.role === 'tool' && m.toolCallId === tc.id);
    const rawOutput = typeof toolMsg?.content === 'string' ? toolMsg.content : '';
    const buffered = state.verificationOutputBuffer.findLastFailed(command);
    const outputForDigest = rawOutput.includes('[BranchBudget / Blocked]') && buffered
      ? buffered.outputBody
      : rawOutput;
    const digest = buildVerificationDigest(command, outputForDigest);
    if (!digest) continue;

    injectRecoveryMessage(deps, state, msgs, correctionPort, digest);
    state.verificationDigestInjectedThisRound = true;
    return;
  }
}

/**
 * P1 — Acceptance ✓ 反馈注入。
 *
 * 两种触发：
 *   - 某条验收命令从 pending → passed → 发一行 `[System / Acceptance ✓] cmd — summary (X/Y passed)`
 *   - 全部验收命令通过 → 追加 stopping signal，告知模型可以输出 ≤10 条交付 bullet 并停止调工具
 *
 * 与失败侧 `maybeInjectVerificationDigest` 对称。
 */
function maybeInjectAcceptanceSuccessFeedback(args: {
  state: HarnessRunState;
  msgs: HarnessRunState['messages'];
  correctionPort: CorrectionPort;
  deps: ToolRoundDeps;
  newlyPassed: Array<{ command: string; summary: string | null }>;
  completedAll: boolean;
}): void {
  const { state, msgs, correctionPort, deps, newlyPassed, completedAll } = args;
  if (deps.supervisorObserverSuppressInject) return;
  if (!state.taskAcceptance?.isActive()) return;

  const passedCount = state.taskAcceptance.getPassedCount();
  const totalCount = state.taskAcceptance.snapshot().commands.length;

  const message = buildAcceptanceSuccessFeedbackMessage({
    newlyPassed,
    completedAll,
    passedCount,
    totalCount,
  });
  if (!message) return;

  injectRecoveryMessage(deps, state, msgs, correctionPort, message);
}

/**
 * 纯函数：构造 Acceptance ✓ 反馈消息。
 *
 * 与 {@link maybeInjectAcceptanceSuccessFeedback} 拆解开，便于单测「文案 + stopping signal」生成逻辑。
 * 返回 null 表示无需注入（既无新增 passed 也未完成全部）。
 */
export function buildAcceptanceSuccessFeedbackMessage(args: {
  newlyPassed: Array<{ command: string; summary: string | null }>;
  completedAll: boolean;
  passedCount: number;
  totalCount: number;
}): string | null {
  const { newlyPassed, completedAll, passedCount, totalCount } = args;
  if (newlyPassed.length === 0 && !completedAll) return null;

  const lines: string[] = [];
  let runningPassed = passedCount - newlyPassed.length;
  for (const item of newlyPassed) {
    runningPassed += 1;
    const cmd = item.command.length > 80 ? `${item.command.slice(0, 77)}...` : item.command;
    const summary = item.summary ? ` — ${item.summary}` : '';
    lines.push(`[System / Acceptance ✓] ${cmd}${summary} (${runningPassed}/${totalCount} passed)`);
  }
  if (completedAll) {
    lines.push(
      '',
      `[System / Acceptance ✓] All ${totalCount} acceptance commands passed.`,
      'Output ≤10 delivery bullets now and STOP calling tools.',
      'Do not re-run verification or open new tool calls; the task is complete.',
    );
  }

  return lines.join('\n');
}

function maybeUpdateBuildDiagnosticGate(
  state: HarnessRunState,
  msgs: HarnessRunState['messages'],
  executableToolCalls: import('../llm/types.js').ToolCall[],
  toolStats: {
    failedSignatures: string[];
    policyBlockedSignatures: string[];
  },
  correctionPort: CorrectionPort,
  deps: ToolRoundDeps,
): void {
  const hadSuccessfulSrcEdit = shouldClearBuildDiagnosticGate({
    toolCalls: executableToolCalls,
    failedSignatures: toolStats.failedSignatures,
    signatureOf: toolCallSignature,
  });

  const shouldActivate = shouldActivateBuildDiagnosticGate({
    branchBudget: state.branchBudget,
    executionFailedSignatures: toolStats.failedSignatures,
    policyBlockedSignatures: toolStats.policyBlockedSignatures,
    toolCalls: executableToolCalls,
    signatureOf: toolCallSignature,
  });

  if (shouldActivate && !hadSuccessfulSrcEdit) {
    if (!state.buildDiagnosticGateActive && !deps.supervisorObserverSuppressInject) {
      injectRecoveryMessage(deps, state, msgs, correctionPort, buildDiagnosticGateMessage());
    }
    state.buildDiagnosticGateActive = true;
    return;
  }

  if (hadSuccessfulSrcEdit) {
    state.buildDiagnosticGateActive = false;
  }
}

function injectRecoveryMessage(
  deps: ToolRoundDeps,
  state: HarnessRunState,
  msgs: HarnessRunState['messages'],
  correctionPort: CorrectionPort,
  content: string,
): void {
  if (deps.supervisorObserverSuppressInject) {
    return;
  }
  if (!deps.executionModeDecisionEnabled) {
    msgs.push({ role: 'user', content });
    return;
  }

  correctionPort.inject(
    { kind: 'recovery', content, preserveOnCompaction: true },
    { phase: state.supervisorPhase, source: 'supervisor' },
  );
}

function failureEscalationCorrectionSource(
  phase: HarnessRunState['supervisorPhase'],
): CorrectionSource {
  return phase === 'free' ? 'lifecycle' : 'supervisor';
}

/**
 * 连续工具失败阶梯 / 同参重复失败提示。
 * L2 adaptive 开启时仍注入（与 branch recover / rebuild 等 C 类 inject 的 suppress 解耦）；
 * free 段经 lifecycle source（不占 I4 budget）；takeover/handoff/cooldown 经 supervisor source。
 */
function injectToolFailureEscalation(
  deps: ToolRoundDeps,
  state: HarnessRunState,
  msgs: HarnessRunState['messages'],
  correctionPort: CorrectionPort,
  content: string,
  options?: { ephemeralFailureRecovery?: EphemeralFailureRecoveryKind; preserveOnCompaction?: boolean },
): void {
  if (!deps.executionModeDecisionEnabled) {
    msgs.push({
      role: 'user',
      content,
      ...(options?.preserveOnCompaction ? { preserveOnCompaction: true } : {}),
      ...(options?.ephemeralFailureRecovery ? { ephemeralFailureRecovery: options.ephemeralFailureRecovery } : {}),
    });
    return;
  }

  correctionPort.inject(
    {
      kind: 'recovery',
      content,
      ...(options?.preserveOnCompaction ? { preserveOnCompaction: true } : {}),
      ...(options?.ephemeralFailureRecovery ? { ephemeralFailureRecovery: options.ephemeralFailureRecovery } : {}),
    },
    { phase: state.supervisorPhase, source: failureEscalationCorrectionSource(state.supervisorPhase) },
  );
}

function injectEphemeralFailureRecovery(
  deps: ToolRoundDeps,
  state: HarnessRunState,
  msgs: HarnessRunState['messages'],
  correctionPort: CorrectionPort,
  content: string,
  kind: EphemeralFailureRecoveryKind,
): void {
  injectToolFailureEscalation(deps, state, msgs, correctionPort, content, { ephemeralFailureRecovery: kind });
}

function topFileEditFromBranchBudget(
  branchBudget: BranchBudgetTracker | undefined,
): { path: string; count: number } | undefined {
  if (!branchBudget) return undefined;
  return topFileEditFromInspect(branchBudget.inspect().fileEdits);
}

function countWriteTargets(toolCalls: LLMResponse['toolCalls'], failedSignatures: Set<string>): number {
  const targets = new Set<string>();
  for (const tc of toolCalls ?? []) {
    if (!TASK_BEARING_WRITE_TOOLS.has(tc.name) || failedSignatures.has(toolCallSignature(tc))) continue;
    const target = typeof tc.arguments?.path === 'string'
      ? tc.arguments.path
      : typeof tc.arguments?.file_path === 'string'
        ? tc.arguments.file_path
        : tc.id;
    targets.add(target);
  }
  return targets.size;
}

