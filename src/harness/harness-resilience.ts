import type { UnifiedMessage, ToolCall } from '../llm/types.js';
import type {
  CheckpointSaveTrigger,
  RuntimeExecutionModeCheckpointState,
} from '../types/runtime-checkpoint.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import type { CheckpointEngine } from './checkpoint-engine.js';
import { shouldSkipResilienceCheckpoint } from './casual-mode.js';
import type { HarnessRunState } from './harness-run-state.js';
import { CompletionFactsView } from './completion-facts-view.js';
import { toolCallSignature } from './harness-permission-runtime.js';
import { ensureExecutionModeFields } from './supervisor/execution-mode-constraints.js';
import { collectRecentErrors, collectRecentToolTraces } from './harness-step-context.js';
import { reviewStep } from './step-review.js';
import type { StopReason } from './types.js';
import type { VerificationOutputTailEntry } from '../types/runtime-checkpoint.js';

export interface ResilienceBridgeDeps {
  /** 没有会话目录时不创建引擎，相关落盘路径直接跳过。 */
  checkpointEngine?: CheckpointEngine;
  enqueueCheckpointPersist: <T>(task: () => Promise<T>) => Promise<T>;
  workspaceRoot?: string;
}

function checkpointVerificationOutputTail(state: HarnessRunState): VerificationOutputTailEntry[] | undefined {
  return state.verificationOutputBuffer?.snapshot();
}

/**
 * 记录一轮工具调用到 branchBudget 和 checkpointEngine。
 * 没有 checkpoint 引擎（无会话目录）时跳过。
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
  if (!deps.checkpointEngine) return;

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
            executionModeState: buildExecutionModeCheckpointState(state),
            verificationOutputTail: checkpointVerificationOutputTail(state),
            ...checkpointHarnessEscalationFields(state),
            appendFailure: {
              signature: sig,
              count: 1,
              at: Date.now(),
            },
            appendTool: {
              toolName: tc.name,
              success: false,
              signature: sig,
              at: Date.now(),
            },
          });
        } catch (err) {
          console.warn(
            '[harness] resilience v2 save (tool_failed) failed:',
            err instanceof Error ? err.message : err,
          );
        }
      });
      continue;
    }

    engine.stage({
      trigger: 'step_completed',
      branchBudget: state.branchBudget,
      executionModeState: buildExecutionModeCheckpointState(state),
      verificationOutputTail: checkpointVerificationOutputTail(state),
      ...checkpointHarnessEscalationFields(state),
      appendTool: {
        toolName: tc.name,
        success: true,
        signature: sig,
        at: Date.now(),
      },
    });
  }
  // step_completed 由本轮收尾的 saveTaskCheckpoint 一次落盘，这里只 stage。
}

/**
 * 检查分支预算是否触发，需要则注入 recovery warning 到对话。
 * 每轮最多注入 1 次，避免与已有的 consecutiveToolFailures 提示叠加。
 */
export function resilienceMaybeBranchRecover(
  deps: ResilienceBridgeDeps,
  state: HarnessRunState,
  msgs: UnifiedMessage[],
): void {
  if (!deps.checkpointEngine) return;
  if (state.branchBudgetWarnedThisRound) return;

  const decision = state.branchBudget.shouldBranchRecover();
  if (!decision.triggered) return;

  const signal = state.branchBudget.buildRecoverySignal(decision);
  if (!signal) return;

  msgs.push({ role: 'user', content: signal.message, preserveOnCompaction: true });
  state.branchBudget.markRecoveryTriggered();
  state.submitModeSignal?.('branch_budget', 'recovery_pending', { dimension: decision.dimension, key: decision.key });
  state.branchBudgetWarnedThisRound = true;

  const engine = deps.checkpointEngine;
  void deps.enqueueCheckpointPersist(async () => {
    try {
      await engine.save({
        trigger: 'tool_failed',
        branchBudget: state.branchBudget,
        executionModeState: buildExecutionModeCheckpointState(state),
        ...checkpointHarnessEscalationFields(state),
        appendRecoverySignal: signal,
      });
    } catch (err) {
      console.warn(
        '[harness] resilience v2 save (recovery signal) failed:',
        err instanceof Error ? err.message : err,
      );
    }
  });
}

/**
 * 在工具失败 / 验证失败时做一次 step review。
 * 每轮最多 1 次；只走本地启发式，不再打旁路 LLM（会堵住主循环 5–15s）。
 */
export async function resilienceMaybeReviewStep(
  deps: ResilienceBridgeDeps,
  state: HarnessRunState,
  trigger: 'tool_failure' | 'verification_failure' | 'step_transition',
): Promise<void> {
  if (state.stepReviewedThisRound) return;
  state.stepReviewedThisRound = true;

  try {
    const recentTools = collectRecentToolTraces(state.messages, 5);
    const lastErrors = collectRecentErrors(state.messages, 3);
    const result = await reviewStep({
      goal: state.taskState.snapshot().goal,
      currentStep: undefined,
      recentTools,
      lastErrors,
      trigger,
      taskSnapshot: state.taskState.snapshot(),
      completionFacts: CompletionFactsView.fromHarnessRunState(state),
      previousReview: state.lastStepReview,
    });

    state.lastStepReview = result;

    // 仅当 step-review 给出"重复 + 建议 fallback"且 branchBudget 这轮没触发时，
    // 才发出一条独立、温和的提示；否则交给现有 consecutiveToolFailures / branchBudget 流程。
    if (
      result.repeatedPattern
      && result.fallbackSuggested
      && !state.branchBudgetWarnedThisRound
    ) {
      const content = `[Runtime Self-Review] ${result.reason} 请切换策略或拆解为更小子任务，不要原样重试。`;
      state.messages.push({ role: 'user', content });
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
  if (!deps.checkpointEngine) return;
  if (!state) return;
  if (shouldSkipResilienceCheckpoint(state.taskState.snapshot().intent)) return;

  const engine = deps.checkpointEngine;
  // free 段不落 step_completed / verification_started；forced 段才覆盖。
  // 这个限制只作用于过程型快照；tool_failed / final_draft 仍照常落盘。
  if (!engine.shouldPersistOnTrigger(trigger)) return;

  await deps.enqueueCheckpointPersist(async () => {
    try {
      await engine.save({
        trigger,
        branchBudget: state.branchBudget,
        executionModeState: buildExecutionModeCheckpointState(state),
        verificationOutputTail: checkpointVerificationOutputTail(state),
        ...checkpointHarnessEscalationFields(state),
        lastStopReason: stopReason,
      });
    } catch (err) {
      console.warn(
        `[harness] resilience v2 save (${trigger}) failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  });
}

export function buildExecutionModeCheckpointState(
  state: HarnessRunState,
): RuntimeExecutionModeCheckpointState {
  ensureExecutionModeFields(state);
  return {
    executionMode: state.executionMode,
    executionModeLockRemaining: state.executionModeLockRemaining,
    executionModeEnteredBy: [...state.executionModeEnteredBy],
    executionModeEnteredByPrimary: state.executionModeEnteredByPrimary,
    executionModeEnteredAtRound: state.executionModeEnteredAtRound ?? null,
    forcedDegradedTier: state.forcedDegradedTier,
    lastModeDecision: state.lastModeDecision,
    pendingModeSignals: [...state.pendingModeSignals],
    forcedTaskBearingRoundsSinceEntry: state.forcedTaskBearingRoundsSinceEntry,
  };
}
