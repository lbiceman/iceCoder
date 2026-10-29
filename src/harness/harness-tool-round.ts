import type { LLMResponse, ToolDefinition } from '../llm/types.js';
import { buildTotalTokenUsageWithContext } from './context-usage-display.js';
import type { CheckpointDeps } from './harness-checkpoint.js';
import { recordTelemetrySummary, saveTaskCheckpoint } from './harness-checkpoint.js';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  FAILURE_EVIDENCE_THRESHOLD_END,
  FAILURE_EVIDENCE_THRESHOLD_START,
  STRONG_WARNING_FAILURE_THRESHOLD,
} from './harness-constants.js';
import {
  buildFailureEvidencePackMessage,
  buildStrongFailureWarningMessage,
  clearResolvedVerificationFailures,
  collectFailureEvidenceEntries,
  purgeEphemeralFailureRecoveryMessagesInPlace,
  type EphemeralFailureRecoveryKind,
} from './failure-evidence-recovery.js';
import type { ResilienceBridgeDeps } from './harness-resilience.js';
import {
  resilienceRecordToolCalls,
  resilienceSaveCheckpoint,
} from './harness-resilience.js';
import { collectRepeatedFailures, toolCallSignature } from './harness-permission-runtime.js';
import { prepareAssistantContentForHistory } from './text-tool-call-salvage.js';
import type { HarnessRunState } from './harness-run-state.js';
import { classifyRunCommandResult } from './run-command-result.js';
import type { RunCommandResultClassification } from './run-command-result.js';
import type { StopHandlerDeps } from './harness-stop-handler.js';
import { handleHarnessStop } from './harness-stop-handler.js';
import type { ToolExecutorDeps } from './harness-tool-executor.js';
import { executeToolCallsStreaming } from './harness-tool-executor.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type { HarnessMemoryIntegration } from './harness-memory.js';
import type { TokenBudgetTracker } from './token-budget.js';
import { emitLightweightSnapshotBoundary } from './checkpoint-snapshot.js';
import { classifyToolRoundProgress } from './tool-round-progress.js';
import { resolveCheckpointUserGoal } from './session-goal-anchor.js';
import { redactToolCalls } from '../tools/tool-argument-redaction.js';
import { recordToolOperationOutcomes } from './operation-outcome.js';
import {
  importAgentVerificationEvidence,
  mergeAgentFileChanges,
  type AgentTaskOutcome,
} from './agents/agent-merge.js';
import { TASK_TOOL_NAME } from './agents/task-tool.js';
import {
  recordVerificationCommandResult,
  syncVerificationWorkspaceMutation,
} from './verification-state.js';
import {
  planTruncatedWriteToolRecovery,
  shouldPlanTruncatedWriteToolRecovery,
} from './harness-tool-truncation-recovery.js';
import type {
  ChatFunction,
  HarnessResult,
  HarnessStepEvent,
  StreamFunction,
} from './types.js';
import { CompletionFactsView } from './completion-facts-view.js';

export interface ToolRoundDeps
  extends Omit<ToolExecutorDeps, 'workspaceRoot'>,
    CheckpointDeps,
    ResilienceBridgeDeps,
    StopHandlerDeps {
  workspaceRoot: string;
  loopController: LoopController;
  memoryIntegration: HarnessMemoryIntegration;
  tokenBudgetTracker?: TokenBudgetTracker;
  /** 单次 LLM max_tokens 上限（与 adapter 对齐，供 write 截断检测）。 */
  agentMaxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** 本轮 task 调用的子 Agent 结果来源（改动文件与验证证据并入父状态） */
  agentSpawner?: Pick<import('./agents/agent-spawner.js').AgentSpawner, 'takeOutcome'>;
}

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
 * 有工具调用时：执行工具、记录 checkpoint、连续失败提示与熔断、循环控制。
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
    // 工具仍以 response 中的原始参数执行；历史/checkpoint 只保存脱敏副本。
    toolCalls: redactToolCalls(response.toolCalls),
  });

  let executableToolCalls = response.toolCalls ?? [];
  if (shouldPlanTruncatedWriteToolRecovery({
    toolCalls: executableToolCalls,
    finishReason: response.finishReason,
    outputTokens: tokenUsage.output,
    maxOutputTokens: deps.agentMaxOutputTokens,
  })) {
    const recovery = planTruncatedWriteToolRecovery(executableToolCalls);
    msgs.push(...recovery.injectedMessages);
    executableToolCalls = recovery.toolCallsToRun;
    if (executableToolCalls.length === 0) {
      return { action: 'continue' };
    }
  }

  deps.missingFileAttempts = state.missingFileAttempts;
  deps.harnessPolicyStats = state.harnessPolicyStats;

  state.taskState.reconcileOrphanFileDeliverableWriteVersions(deps.workspaceRoot);

  deps.checkpointEngine?.setToolExecutionLock(true);
  deps.checkpointManager?.setPersistBlocked(true);
  let toolStats;
  try {
    toolStats = await executeToolCallsStreaming(deps, {
    toolCalls: executableToolCalls,
    messages: msgs,
    logger,
    onStep,
    harnessAbortSignal: deps.abortSignal,
    taskState: state.taskState,
    repoContext: state.repoContext,
    chatFn,
    currentTools,
    completionFacts: CompletionFactsView.fromHarnessRunState(state),
    verificationOutputBuffer: state.verificationOutputBuffer,
    shellMandatoryConfirmDenials: state.shellMandatoryConfirmDenials,
  });
  } finally {
    deps.checkpointEngine?.setToolExecutionLock(false);
    deps.checkpointManager?.setPersistBlocked(false);
  }
  emitLightweightSnapshotBoundary({
    boundary: 'tool_batch_completed',
    detail: `${executableToolCalls.length} tool call(s)`,
  });
  const recordedOutcomes = recordToolOperationOutcomes(state.operationOutcomes, {
    toolCalls: executableToolCalls,
    messages: msgs,
    failedSignatures: toolStats.failedSignatures,
    policyBlockedSignatures: toolStats.policyBlockedSignatures,
  });
  const workspaceMutatedRunCommandIds = new Set(
    toolStats.workspaceMutatedRunCommandIds,
  );
  for (const outcome of recordedOutcomes) {
    if (!workspaceMutatedRunCommandIds.has(outcome.toolCallId)) continue;
    state.operationOutcomes?.record({ ...outcome, effect: 'local_change' });
  }
  // 普通模型工具轮直接更新当前 VerificationPlan 的逐命令证据。
  // 后台 start/running 不计入；只有真实 terminal 分类才能改变进度。
  const runCommandClassifications = new Map<string, RunCommandResultClassification>();
  const agentOutcomes: AgentTaskOutcome[] = [];
  for (const tc of executableToolCalls) {
    if (tc.name !== TASK_TOOL_NAME) continue;
    const outcome = deps.agentSpawner?.takeOutcome(tc.id);
    if (!outcome) continue;
    mergeAgentFileChanges(tc.id, outcome, state);
    agentOutcomes.push(outcome);
  }
  syncVerificationWorkspaceMutation(state.verificationState, state.taskState);
  const currentVerificationPlan = state.verificationPlanResolution.kind === 'resolved'
    ? state.verificationPlanResolution.plan
    : null;
  for (const outcome of agentOutcomes) {
    importAgentVerificationEvidence(outcome, state.verificationState, currentVerificationPlan);
  }
  for (const tc of executableToolCalls) {
    if (tc.name !== 'run_command') continue;
    const sig = toolCallSignature(tc);
    const success = !toolStats.failedSignatures.includes(sig)
      && !toolStats.policyBlockedSignatures.includes(sig);
    const toolMsg = msgs.find(m => m.role === 'tool' && m.toolCallId === tc.id);
    const rawOutput = typeof toolMsg?.content === 'string' ? toolMsg.content : '';
    const classified = classifyRunCommandResult(tc.arguments as Record<string, unknown>, rawOutput, success);
    if (!classified) continue;
    runCommandClassifications.set(tc.id, classified);

    if (currentVerificationPlan) {
      recordVerificationCommandResult(state.verificationState, {
        plan: currentVerificationPlan,
        result: classified,
        evidenceRef: tc.id,
        ...(toolStats.workspaceMutationVersionBeforeRunCommand[tc.id] !== undefined
          ? {
              mutationVersion:
                toolStats.workspaceMutationVersionBeforeRunCommand[tc.id],
            }
          : {}),
      });
    }

    if (classified.kind === 'background_failed'
      && state.verificationOutputBuffer) {
      state.verificationOutputBuffer.recordFailed(classified.command, rawOutput);
    }
  }

  await resilienceRecordToolCalls(
    deps,
    executableToolCalls,
    new Set(toolStats.failedSignatures),
    state,
  );

  // cleanup/删除命令执行后，从 filesChanged 剔除已不存在的路径，避免下轮 Gate 要求重读
  state.taskState.reconcileMissingChangedFiles(deps.workspaceRoot);
  state.repoContext.reconcileMissingChangedFiles(deps.workspaceRoot);

  const repeatedFailures = collectRepeatedFailures(
    executableToolCalls,
    toolStats.failedSignatures,
    state.failedToolCallSignatures,
  );
  if (repeatedFailures.length > 0) {
    injectToolFailureEscalation(
      msgs,
      `[System] Repeated failed tool call detected: ${repeatedFailures.join(', ')}. Do not retry the same tool with the same arguments. Change the path, parameters, command, or use a different tool; if blocked, explain the exact blocker and evidence.`,
      { preserveOnCompaction: true },
    );
  }

  // 用户中断早退：在 verification_failed checkpoint 之前先检查 isAborted。
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

  if (CompletionFactsView.fromHarnessRunState(state).verificationSignal().status === 'failed'
    || state.verificationState?.lastResult?.status === 'failed') {
    await resilienceSaveCheckpoint(deps, 'verification_failed', state);
  }

  const roundProgress = classifyToolRoundProgress({
    executableToolCalls,
    failedSignatures: toolStats.failedSignatures,
    policyBlockedSignatures: toolStats.policyBlockedSignatures,
    runCommandClassifications,
  });

  if (roundProgress === 'all_failed_or_blocked') {
    state.consecutiveToolFailures++;
    const failureCount = state.consecutiveToolFailures;

    if (failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
      console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，触发熔断`);
      deps.loopController.stop('circuit_breaker');
      const finalState = deps.loopController.getState();
      logger.loopStop('circuit_breaker', finalState.currentRound, finalState.totalToolCalls);
      state.completionStatus = 'failed';
      state.completionReason = 'circuit_breaker';
      await saveTaskCheckpoint(deps, 'failed', resolveCheckpointUserGoal(state, userMessage), msgs, state, 'circuit_breaker');
      recordTelemetrySummary(deps, 'circuit_breaker', state, {
        status: 'failed',
        reason: 'circuit_breaker',
      });

      onStep?.({
        type: 'final',
        iteration: finalState.currentRound,
        totalToolCalls: finalState.totalToolCalls,
        content: `${failureCount} consecutive rounds of tool calls failed, circuit breaker triggered.`,
        stopReason: 'circuit_breaker',
        completionStatus: 'failed',
        completionReason: 'circuit_breaker',
      });

      return {
        action: 'return',
        result: {
          content: `${failureCount} consecutive rounds of tool calls failed, circuit breaker triggered. The last errors have been logged; please check tool configuration or environment and retry.`,
          loopState: finalState,
          messages: [...msgs],
          log: logger.getEntries(),
          completionStatus: 'failed',
          completionReason: 'circuit_breaker',
        },
      };
    }

    if (failureCount >= STRONG_WARNING_FAILURE_THRESHOLD) {
      purgeEphemeralFailureRecoveryMessagesInPlace(msgs);
      injectEphemeralFailureRecovery(
        msgs,
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
        msgs,
        buildFailureEvidencePackMessage(failureCount, entries),
        'evidence',
      );
      console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，注入失败证据包`);
    }
  } else if (roundProgress === 'meaningful_progress') {
    state.consecutiveToolFailures = 0;
    state.stopHookContinuationCount = 0;
    purgeEphemeralFailureRecoveryMessagesInPlace(msgs);
    clearResolvedVerificationFailures(state.verificationOutputBuffer, runCommandClassifications);
  }
  // 只读空转（如读已有 src 模板）：不清零 consecutiveToolFailures，避免熔断永远达不到阈值。

  await saveTaskCheckpoint(
    deps,
    'running',
    resolveCheckpointUserGoal(state, userMessage),
    msgs,
    state,
    undefined,
    'step_completed',
  );

  onStep?.({
    type: 'context_usage',
    iteration: round,
    totalTokenUsage: buildTotalTokenUsageWithContext(msgs, currentTools, {
      lastInputTokens: deps.loopController.getState().lastInputTokens,
      lastOutputTokens: deps.loopController.getState().lastOutputTokens,
    }),
  });

  if (executableToolCalls.length > 0) {
    state.hadToolRoundThisRun = true;
  }

  // 工具轮后不在这里做标准召回。下一轮仍走关键词，除非话题切换或在问约定。

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

/** 连续工具失败阶梯 / 同参重复失败提示，直接写入 Harness 消息。 */
function injectToolFailureEscalation(
  msgs: HarnessRunState['messages'],
  content: string,
  options?: { ephemeralFailureRecovery?: EphemeralFailureRecoveryKind; preserveOnCompaction?: boolean },
): void {
  msgs.push({
    role: 'user',
    content,
    ...(options?.preserveOnCompaction ? { preserveOnCompaction: true } : {}),
    ...(options?.ephemeralFailureRecovery ? { ephemeralFailureRecovery: options.ephemeralFailureRecovery } : {}),
  });
}

function injectEphemeralFailureRecovery(
  msgs: HarnessRunState['messages'],
  content: string,
  kind: EphemeralFailureRecoveryKind,
): void {
  injectToolFailureEscalation(msgs, content, { ephemeralFailureRecovery: kind });
}
