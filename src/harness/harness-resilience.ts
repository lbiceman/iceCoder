import type { UnifiedMessage, ToolCall } from '../llm/types.js';
import type {
  CheckpointSaveTrigger,
  RuntimeSupervisorCheckpointState,
} from '../types/runtime-checkpoint.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import type { CheckpointEngine } from './checkpoint-engine.js';
import { shouldSkipResilienceCheckpoint } from './casual-mode.js';
import type { HarnessRunState } from './harness-run-state.js';
import { toolCallSignature } from './harness-permission-runtime.js';
import { collectRecentErrors, collectRecentToolTraces } from './harness-step-context.js';
import { reviewStep } from './step-review.js';
import type { ChatFunction, StopReason } from './types.js';
import type { CorrectionPort } from '../types/supervisor.js';
import type { VerificationOutputTailEntry, AcceptanceGateSnapshot } from '../types/runtime-checkpoint.js';

export interface ResilienceBridgeDeps {
  resilienceV2Enabled: boolean;
  checkpointEngine?: CheckpointEngine;
  enqueueCheckpointPersist: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * L2-2：Supervisor PassiveObserver 活跃时关闭 free 段 recovery inject（§19.6）。
   * 仍保留 branch 计数、checkpoint 与 submitModeSignal。
   */
  supervisorObserverSuppressInject?: boolean;
}

function checkpointVerificationOutputTail(state: HarnessRunState): VerificationOutputTailEntry[] | undefined {
  return state.verificationOutputBuffer?.snapshot();
}

function checkpointAcceptanceGate(state: HarnessRunState): AcceptanceGateSnapshot | undefined {
  if (!state.taskAcceptance?.isActive()) return undefined;
  return state.taskAcceptance.snapshot();
}

/**
 * 记录一轮工具调用到 branchBudget 和 checkpointEngine。
 * 关 flag 时 no-op。
 *
 * 磁盘写入必须经 enqueueCheckpointPersist，与 TaskCheckpointManager 串行，避免绕过队列与 v1 save 交叉 rename。
 */
function checkpointHarnessEscalationFields(state: HarnessRunState): {
  rebuildEscalationInjections: number;
  parallelBudgetBlockHintInjected: boolean;
} {
  return {
    rebuildEscalationInjections: state.rebuildEscalationInjections,
    parallelBudgetBlockHintInjected: state.parallelBudgetBlockHintInjected,
  };
}

export async function resilienceRecordToolCalls(
  deps: ResilienceBridgeDeps,
  toolCalls: ToolCall[],
  failedSignatures: Set<string>,
  policyBlockedSignatures: Set<string>,
  state: HarnessRunState,
  workspaceRoot?: string,
): Promise<void> {
  if (!deps.resilienceV2Enabled || !state.branchBudget || !deps.checkpointEngine) return;

  state.branchBudget.bindWorkspaceRoot(workspaceRoot);
  const engine = deps.checkpointEngine;

  for (const tc of toolCalls) {
    const sig = toolCallSignature(tc);
    const failed = failedSignatures.has(sig);
    const policyBlocked = policyBlockedSignatures.has(sig);

    const path = typeof tc.arguments?.path === 'string'
      ? tc.arguments.path
      : (typeof tc.arguments?.file_path === 'string' ? tc.arguments.file_path : undefined);
    if (
      path
      && /^(edit_file|write_file|append_file|batch_edit_file|patch_file)$/.test(tc.name)
      && !failed
      && !policyBlocked
    ) {
      state.branchBudget.recordFileEdit(path);
    }

    if (tc.name === 'run_command' && failed) {
      const cmd = typeof tc.arguments?.command === 'string' ? tc.arguments.command : '';
      if (cmd) state.branchBudget.recordFailedCommandAttempt(cmd);
    }

    if (failed) {
      state.branchBudget.recordError(sig);
      await deps.enqueueCheckpointPersist(async () => {
        try {
          await engine.save({
            trigger: 'tool_failed',
            branchBudget: state.branchBudget,
            supervisorState: buildSupervisorCheckpointState(state),
            verificationOutputTail: checkpointVerificationOutputTail(state),
            acceptanceGate: checkpointAcceptanceGate(state),
            ...checkpointHarnessEscalationFields(state),
            appendFailure: {
              signature: sig,
              count: 1,
              at: Date.now(),
            },
          });
        } catch (err) {
          console.debug(
            '[harness] resilience v2 save (tool_failed) failed:',
            err instanceof Error ? err.message : err,
          );
        }
      });
    }

    const perToolTrigger: CheckpointSaveTrigger = failed ? 'tool_failed' : 'step_completed';
    if (!engine.shouldPersistOnTrigger(perToolTrigger)) continue;
    await deps.enqueueCheckpointPersist(async () => {
      try {
        await engine.save({
          trigger: perToolTrigger,
          branchBudget: state.branchBudget,
          supervisorState: buildSupervisorCheckpointState(state),
          verificationOutputTail: checkpointVerificationOutputTail(state),
          acceptanceGate: checkpointAcceptanceGate(state),
          ...checkpointHarnessEscalationFields(state),
          appendTool: {
            toolName: tc.name,
            success: !failed,
            signature: sig,
            at: Date.now(),
          },
        });
      } catch (err) {
        console.debug(
          '[harness] resilience v2 save (tool) failed:',
          err instanceof Error ? err.message : err,
        );
      }
    });
  }
}

/**
 * 检查分支预算是否触发，需要则注入 recovery warning 到对话。
 * 每轮最多注入 1 次，避免与已有的 consecutiveToolFailures 提示叠加。
 */
export function resilienceMaybeBranchRecover(
  deps: ResilienceBridgeDeps,
  state: HarnessRunState,
  msgs: UnifiedMessage[],
  correctionPort?: CorrectionPort,
): void {
  if (!deps.resilienceV2Enabled || !state.branchBudget || !deps.checkpointEngine) return;
  if (state.branchBudgetWarnedThisRound) return;

  const decision = state.branchBudget.shouldBranchRecover();
  if (!decision.triggered) return;

  const signal = state.branchBudget.buildRecoverySignal(decision);
  if (!signal) return;

  const suppressInject = deps.supervisorObserverSuppressInject === true;
  if (!suppressInject) {
    if (correctionPort) {
      correctionPort.inject(
        { kind: 'recovery', content: signal.message, preserveOnCompaction: true },
        { phase: state.supervisorPhase, source: 'supervisor' },
      );
    } else {
      msgs.push({ role: 'user', content: signal.message });
    }
  }
  state.branchBudget.markRecoveryTriggered();
  state.submitModeSignal?.('branch_budget', 'recovery_pending', { dimension: decision.dimension, key: decision.key });
  state.branchBudgetWarnedThisRound = true;

  const engine = deps.checkpointEngine;
  void deps.enqueueCheckpointPersist(async () => {
    try {
      await engine.save({
        trigger: 'tool_failed',
        branchBudget: state.branchBudget,
        supervisorState: buildSupervisorCheckpointState(state),
        ...checkpointHarnessEscalationFields(state),
        appendRecoverySignal: signal,
      });
    } catch (err) {
      console.debug(
        '[harness] resilience v2 save (recovery signal) failed:',
        err instanceof Error ? err.message : err,
      );
    }
  });
}

/**
 * 在工具失败 / 验证失败时做一次 step review。
 * 每轮最多 1 次；启发式给出明确结论时不触发 LLM。
 */
export async function resilienceMaybeReviewStep(
  deps: ResilienceBridgeDeps,
  state: HarnessRunState,
  trigger: 'tool_failure' | 'verification_failure' | 'step_transition',
  chatFn: ChatFunction,
  correctionPort?: CorrectionPort,
): Promise<void> {
  if (!deps.resilienceV2Enabled) return;
  if (state.stepReviewedThisRound) return;
  state.stepReviewedThisRound = true;

  try {
    const recentTools = collectRecentToolTraces(state.messages, 5);
    const lastErrors = collectRecentErrors(state.messages, 3);
    // planActive/activeStep removed (Phase 11 — currentPlanTracker deleted)

    const result = await reviewStep({
      goal: state.taskState.snapshot().goal,
      currentStep: undefined, // activeStep removed (Phase 11)
      recentTools,
      lastErrors,
      trigger,
      taskSnapshot: state.taskState.snapshot(),
      previousReview: state.lastStepReview,
    }, chatFn);

    state.lastStepReview = result;

    // 仅当 step-review 给出"重复 + 建议 fallback"且 branchBudget 这轮没触发时，
    // 才发出一条独立、温和的提示；否则交给现有 consecutiveToolFailures / branchBudget 流程。
    if (
      result.repeatedPattern
      && result.fallbackSuggested
      && !state.branchBudgetWarnedThisRound
    ) {
      const suppressInject = deps.supervisorObserverSuppressInject === true;
      if (!suppressInject) {
        const content = `[Runtime Self-Review] ${result.reason} 请切换策略或拆解为更小子任务，不要原样重试。`;
        if (correctionPort) {
          correctionPort.inject(
            { kind: 'recovery', content },
            { phase: state.supervisorPhase, source: 'supervisor' },
          );
        } else {
          state.messages.push({ role: 'user', content });
        }
      }
      state.branchBudgetWarnedThisRound = true;
    }
  } catch (err) {
    console.debug(
      '[harness] resilience v2 step-review failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * v2 checkpoint 合并保存。在以下 hook 点调用：
 *   step_completed / tool_failed / verification_started / verification_failed
 *   compaction / final_draft
 */
export async function resilienceSaveCheckpoint(
  deps: ResilienceBridgeDeps,
  trigger: CheckpointSaveTrigger,
  state: HarnessRunState | undefined,
  stopReason?: StopReason,
): Promise<void> {
  if (!deps.resilienceV2Enabled || !deps.checkpointEngine) return;
  if (!state) return;
  if (shouldSkipResilienceCheckpoint(state.taskState.snapshot().intent)) return;

  const engine = deps.checkpointEngine;
  // W6: free 段不落 step_completed / verification_started；forced 段才覆盖。
  //     该 gating 仅作用于资源相对昂贵的"过程型"快照；tool_failed / final_draft 等仍按原行为。
  if (!engine.shouldPersistOnTrigger(trigger)) return;

  await deps.enqueueCheckpointPersist(async () => {
    try {
      await engine.save({
        trigger,
        branchBudget: state.branchBudget,
        supervisorState: buildSupervisorCheckpointState(state),
        verificationOutputTail: checkpointVerificationOutputTail(state),
        acceptanceGate: checkpointAcceptanceGate(state),
        ...checkpointHarnessEscalationFields(state),
        verificationPending: state.taskState.shouldBlockFinalForVerification(
          state.taskAcceptance?.isActive() && !state.taskAcceptance.isComplete(),
        ),
        lastStopReason: stopReason,
      });
    } catch (err) {
      console.debug(
        `[harness] resilience v2 save (${trigger}) failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  });
}

export function buildSupervisorCheckpointState(
  state: HarnessRunState,
): RuntimeSupervisorCheckpointState {
  const bridge = state.supervisorBridge;
  const bridgeSnapshot = bridge?.isActive() ? bridge.snapshotForCheckpoint() : undefined;
  return {
    executionMode: state.executionMode ?? 'free',
    executionModeLockRemaining: state.executionModeLockRemaining ?? 0,
    executionModeEnteredBy: [...(state.executionModeEnteredBy ?? [])],
    executionModeEnteredByPrimary: state.executionModeEnteredByPrimary,
    executionModeEnteredAtRound: state.executionModeEnteredAtRound ?? null,
    forcedDegradedTier: state.forcedDegradedTier,
    lastModeDecision: state.lastModeDecision,
    pendingModeSignals: [...(state.pendingModeSignals ?? [])],
    forcedTaskBearingRoundsSinceEntry: state.forcedTaskBearingRoundsSinceEntry ?? 0,
    // L2-6 / T08：bridge 持有的 phase / RecoverySupervisor snapshot / timeline tail / I4 budget。
    supervisorPhase: bridgeSnapshot?.supervisorPhase ?? state.supervisorPhase,
    recoverySupervisorSnapshot: bridgeSnapshot?.recoverySupervisorSnapshot,
    timelineTail: bridgeSnapshot?.timelineTail,
    correctionBudgetUsed: bridgeSnapshot?.correctionBudgetUsed ?? 0,
    segmentRenewalCount: bridgeSnapshot?.segmentRenewalCount ?? state.segmentRenewalCount ?? 0,
  };
}
