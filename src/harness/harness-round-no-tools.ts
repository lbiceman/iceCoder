import type { LLMResponse } from '../llm/types.js';
import { buildTotalTokenUsageWithContext } from './context-usage-display.js';
import { shouldApplyCasualHarness } from './casual-mode.js';
import type { CheckpointDeps } from './harness-checkpoint.js';
import { recordTelemetrySummary, saveTaskCheckpoint } from './harness-checkpoint.js';
import { resolveCheckpointUserGoal } from './session-goal-anchor.js';
import {
  MAX_EMPTY_RESPONSE_RETRIES,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  MAX_REASONING_ONLY_RECOVERY,
  MAX_STOP_HOOK_CONTINUATIONS,
} from './harness-constants.js';
import type { HarnessMemoryIntegration } from './harness-memory.js';
import {
  getLatestRealUserText,
  hasAssistantToolCallAfterLatestRealUser,
} from './harness-message-utils.js';
import {
  buildIncompleteContinuationPrompt,
  hasPendingWork,
  isReasoningOnlyResponse,
} from './incomplete-completion.js';
import { isResumeContinuationMessage } from './resume-goal.js';
import type { ResilienceBridgeDeps } from './harness-resilience.js';
import { resilienceSaveCheckpoint } from './harness-resilience.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type { GraphExecutor } from './task-graph-executor.js';
import type { StopHookManager } from './stop-hooks.js';
import type { ToolExecutorDeps } from './harness-tool-executor.js';
import type { ToolExecutor } from '../tools/tool-executor.js';
import type { ToolPermissionRule } from './types.js';
import type {
  HarnessResult,
  HarnessStepEvent,
  StopReason,
} from './types.js';
import type { ToolDefinition } from '../llm/types.js';
import type { UnifiedMessage } from '../llm/types.js';
import {
  evaluateCompletionHardState,
  type CompletionReason,
  type CompletionStatus,
} from './completion-state.js';
import { hasEngineeringTestTargets } from './document-deliverable.js';
import {
  executeStopVerificationPlan,
  type StopVerificationResult,
} from './harness-stop-verification.js';
import { createHarnessVerificationToolAdapter } from './harness-verification-tool-adapter.js';
import {
  createVerificationRuntimeState,
  isVerificationFresh,
  syncVerificationWorkspaceMutation,
  tryConsumeVerificationContinuation,
} from './verification-state.js';
import { emitLightweightSnapshotBoundary } from './checkpoint-snapshot.js';
import {
  containsEmbeddedToolCalls,
  prepareAssistantContentForHistory,
  sanitizeAssistantContentForUser,
} from './text-tool-call-salvage.js';

function buildNoToolExecutionRecoveryPrompt(): string {
  return '[System] The user requested an executable action, but no tool was invoked. Continue with the relevant available tools through native function-calling; do not embed tool syntax in plain text.';
}

function pushAssistantForHistory(
  msgs: UnifiedMessage[],
  response: LLMResponse,
): void {
  const content = prepareAssistantContentForHistory(response.content);
  if (!content) return;
  msgs.push({ role: 'assistant', content });
}

export interface NoToolRoundDeps extends CheckpointDeps, ResilienceBridgeDeps {
  loopController: LoopController;
  memoryIntegration: HarnessMemoryIntegration;
  stopHookManager: StopHookManager;
  graphExecutor: GraphExecutor;
  workspaceRoot?: string;
  toolExecutor?: ToolExecutor;
  permissionRules?: ToolPermissionRule[];
  skipPermissionChecks?: boolean;
  onConfirm?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  onShellMandatoryConfirm?: (
    request: import('./harness-permission-runtime.js').ShellMandatoryConfirmRequest,
  ) => Promise<boolean>;
  shellCollabActive?: boolean;
  planModeActive?: boolean;
  lockedWorkspaceRoot?: string;
  referenceReads?: string[];
  sessionId?: string;
  sessionDir?: string;
  abortSignal?: AbortSignal;
}

export interface HandleNoToolCallsArgs {
  state: HarnessRunState;
  response: LLMResponse;
  /** API 原始 assistant 正文（净化前），用于识别「嵌入工具文本」避免误判空响应 / 提前结束 */
  rawAssistantContent?: string | undefined;
  userMessage: string;
  currentTools: ToolDefinition[];
  tokenUsage: { input: number; output: number };
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
}

export type HandleNoToolCallsResult =
  | { action: 'continue' }
  | { action: 'return'; result: HarnessResult };

function injectContinuationUserMessage(
  _deps: NoToolRoundDeps,
  _state: HarnessRunState,
  msgs: UnifiedMessage[],
  content: string,
): void {
  msgs.push({ role: 'user', content, preserveOnCompaction: true });
}

/**
 * 无工具调用时的响应处理：失忆恢复、max-output-tokens、空响应、stop hook、验证拦截、正常完成。
 */
export async function handleNoToolCalls(
  deps: NoToolRoundDeps,
  args: HandleNoToolCallsArgs,
): Promise<HandleNoToolCallsResult> {
  const { state, response, rawAssistantContent, userMessage, currentTools, tokenUsage, logger, onStep } = args;
  const msgs = state.messages;
  state.consecutiveNoToolRounds++;

  const rawTextForEmbedded =
    (typeof rawAssistantContent === 'string' ? rawAssistantContent : '')
    || (typeof response.content === 'string' ? response.content : '');
  const hasEmbeddedToolText = containsEmbeddedToolCalls(rawTextForEmbedded);

  // 模型在 API tool_calls 之后又用正文输出工具（各厂商格式不同）→ 必须继续，不能 model_done / 空响应退出
  if (
    hasEmbeddedToolText
    && currentTools.length > 0
    && state.noToolExecutionRecoveryCount < 1
  ) {
    state.noToolExecutionRecoveryCount++;
    console.log('[harness] 检测到正文中嵌入工具调用（未走 API），注入恢复提示并继续');
    if (rawTextForEmbedded || response.content) {
      pushAssistantForHistory(msgs, {
        ...response,
        content: rawTextForEmbedded || response.content,
      });
    }
    msgs.push({
      role: 'user',
      content: [
        buildNoToolExecutionRecoveryPrompt(),
        '',
        'The previous reply contained tool-like XML/text in the message body. Use native function-calling only — do not repeat tool syntax in plain text.',
      ].join('\n'),
    });
    state.transition = 'no_tool_execution_recovery';
    return { action: 'continue' };
  }

  if (state.justCompacted && state.amnesiaRecoveryCount < 1) {
    const responseText = response.content || '';
    const amnesiaPatterns = [
      /无法确定.*任务/, /不确定.*任务/, /忘记/, /请重复/, /请描述/,
      /unsure what task/i, /don'?t know what task/i, /what (was|is) the task/i,
      /can'?t remember/i, /forgot/i, /what would you like/i,
    ];
    const isAmnesia = amnesiaPatterns.some(p => p.test(responseText));
    if (isAmnesia) {
      state.amnesiaRecoveryCount++;
      console.log('[harness] 检测到压缩后失忆，自动注入任务上下文...');
      if (response.content) {
        msgs.push({ role: 'assistant', content: prepareAssistantContentForHistory(response.content) });
      }
      try {
        const sessionNotes = await deps.memoryIntegration.getSessionMemoryForCompact();
        if (sessionNotes) {
          msgs.push({
            role: 'user',
            content: `<system-reminder>\n## Task Recovery\nContext was just compressed. Your session notes contain the current task:\n\n${sessionNotes.substring(0, 1500)}\n\nContinue executing the task described above. Do NOT ask the user to repeat the task.\n</system-reminder>`,
          });
        } else {
          msgs.push({
            role: 'user',
            content: '[System: Context was just compressed. Continue with the most recent task. Check the conversation history above for the task description. Do not ask the user to repeat the task.]',
          });
        }
      } catch {
        msgs.push({
          role: 'user',
          content: '[System: Context was just compressed. Continue with the most recent task. If you cannot determine the task, check the files you were working on.]',
        });
      }
      state.justCompacted = false;
      return { action: 'continue' };
    }
    state.justCompacted = false;
  }

  if (
    response.finishReason === 'length'
    && state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
  ) {
    state.maxOutputTokensRecoveryCount++;
    console.log(
      `[harness] max-output-tokens 恢复 (${state.maxOutputTokensRecoveryCount}/${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT})`,
    );

    pushAssistantForHistory(msgs, response);
    msgs.push({
      role: 'user',
      content: 'Continue directly — do not apologize, do not restate previous content. If the last response was cut off mid-way, continue from where it left off. Split remaining work into smaller steps.',
    });
    state.transition = 'max_output_tokens_recovery';
    return { action: 'continue' };
  }

  if (
    response.finishReason === 'length'
    && state.maxOutputTokensRecoveryCount >= MAX_OUTPUT_TOKENS_RECOVERY_LIMIT
  ) {
    return finishNoToolRound(deps, args, {
      status: 'interrupted',
      reason: 'max_output_tokens',
      stopReason: 'max_output_tokens',
      content: sanitizeAssistantContentForUser(response.content),
    });
  }

  if (
    ((!response.content || !response.content.trim()) || isReasoningOnlyResponse(response))
    && !hasEmbeddedToolText
    && state.emptyResponseRetryCount < MAX_EMPTY_RESPONSE_RETRIES
  ) {
    state.emptyResponseRetryCount++;
    console.log(
      `[harness] LLM 空响应/仅思考重试 (${state.emptyResponseRetryCount}/${MAX_EMPTY_RESPONSE_RETRIES})`,
    );
    pushAssistantForHistory(msgs, response);
    msgs.push({
      role: 'user',
      content: 'Continue the requested task with relevant available tools. Do not stop with thinking only.',
    });
    state.transition = 'max_output_tokens_recovery';
    return { action: 'continue' };
  }

  if (
    isReasoningOnlyResponse(response)
    && state.reasoningOnlyRecoveryCount < MAX_REASONING_ONLY_RECOVERY
  ) {
    state.reasoningOnlyRecoveryCount++;
    console.log(
      `[harness] reasoning-only 恢复 (${state.reasoningOnlyRecoveryCount}/${MAX_REASONING_ONLY_RECOVERY})`,
    );
    msgs.push({
      role: 'user',
      content: buildIncompleteContinuationPrompt(
        state.taskState.snapshot(),
        state.repoContext.snapshot(),
        deps.workspaceRoot,
      ),
    });
    state.transition = 'no_tool_execution_recovery';
    return { action: 'continue' };
  }

  if (
    (!response.content || !response.content.trim())
    && !response.reasoningContent?.trim()
    && !hasEmbeddedToolText
  ) {
    return finishNoToolRound(deps, args, {
      status: 'failed',
      reason: 'error',
      stopReason: 'error',
      content: 'LLM returned empty response, please retry.',
    });
  }

  state.emptyResponseRetryCount = 0;

  // 删除/cleanup 后同步 filesChanged，避免收尾仍引用已不存在的交付物。
  state.taskState.reconcileMissingChangedFiles(deps.workspaceRoot);
  state.repoContext.reconcileMissingChangedFiles(deps.workspaceRoot);

  const taskSnap = state.taskState.snapshot();
  const workspaceRoot = deps.workspaceRoot;
  const pendingWork = hasPendingWork(taskSnap, workspaceRoot);
  const latestUserText = getLatestRealUserText(msgs, userMessage);
  const resumeWithPending = isResumeContinuationMessage(latestUserText) && pendingWork;
  const hasToolCallSinceUser = hasAssistantToolCallAfterLatestRealUser(msgs);

  // 实现任务从未真正调用工具时，保留一次协议恢复；验收计划不消费这份预算。
  if (
    currentTools.length > 0
    && state.noToolExecutionRecoveryCount < 1
    && state.stopHookContinuationCount === 0
    && !hasToolCallSinceUser
    && (
      resumeWithPending
      || (pendingWork && isImplementationIntent(taskSnap.intent))
    )
  ) {
    state.noToolExecutionRecoveryCount++;
    pushAssistantForHistory(msgs, response);
    msgs.push({
      role: 'user',
      content: buildNoToolExecutionRecoveryPrompt(),
    });
    state.transition = 'no_tool_execution_recovery';
    return { action: 'continue' };
  }

  // 状态门控：以下任一成立 → 跳过 stop hook
  // 1) 问答 / 查看类意图（casual harness）
  // 2) 已有写文件变更（D′ 停时验收接管）
  // 3) 没有遗留工作且本轮已经动过工具 → 任务自然完成
  const skipStopHook =
    shouldApplyCasualHarness(taskSnap.intent)
    || taskSnap.filesChanged.length > 0
    || (!pendingWork && hasToolCallSinceUser);

  if (deps.stopHookManager.count > 0 && !skipStopHook) {
    const hookText = [response.content, response.reasoningContent].filter(Boolean).join('\n');
    const hookResult = await deps.stopHookManager.execute(msgs, hookText);
    if (hookResult.shouldContinue && hookResult.message) {
      state.stopHookContinuationCount++;
      if (state.stopHookContinuationCount > MAX_STOP_HOOK_CONTINUATIONS) {
        console.log(`[harness] 停止钩子连续干预 ${state.stopHookContinuationCount} 次，强制停止`);
        return finishNoToolRound(deps, args, {
          status: 'paused',
          reason: 'stop_hook',
          stopReason: 'stop_hook',
          content: sanitizeAssistantContentForUser(response.content),
        });
      }

      console.log(`[harness] 停止钩子 "${hookResult.hookName}" 要求继续 (${state.stopHookContinuationCount}/${MAX_STOP_HOOK_CONTINUATIONS})`);
      msgs.push({ role: 'user', content: hookResult.message });
      state.transition = 'stop_hook_continue';
      return { action: 'continue' };
    }
  }

  const hardState = evaluateCompletionHardState(state.operationOutcomes);
  if (hardState) {
    return finishNoToolRound(deps, args, {
      status: hardState.status,
      reason: hardState.reason,
      stopReason: hardState.status === 'failed'
        ? 'completion_failed'
        : 'completion_paused',
      content: sanitizeAssistantContentForUser(response.content),
    });
  }

  state.stopHookContinuationCount = 0;
  state.verificationState ??= createVerificationRuntimeState();
  syncVerificationWorkspaceMutation(state.verificationState, state.taskState);
  const resolution = state.verificationPlanResolution ?? { kind: 'unavailable' as const };
  const hasEngineeringChanges = hasEngineeringTestTargets(taskSnap.filesChanged);

  if (resolution.kind === 'invalid') {
    return finishNoToolRound(deps, args, {
      status: 'paused',
      reason: 'verification_plan_invalid',
      stopReason: 'completion_paused',
      content: sanitizeAssistantContentForUser(response.content),
    });
  }

  const hasExplicitUserPlan = resolution.kind === 'resolved'
    && resolution.plan.source === 'user';
  // question / inspect / 纯阅读直接结束；严格用户验收 marker 则按 test-only 任务执行。
  if (
    (taskSnap.intent === 'question' || taskSnap.intent === 'inspect')
    && !hasExplicitUserPlan
  ) {
    return finishNoToolRound(deps, args, {
      status: 'completed',
      reason: 'verification_not_required',
      stopReason: 'model_done',
      content: sanitizeAssistantContentForUser(response.content),
    });
  }

  if (resolution.kind !== 'resolved') {
    return finishNoToolRound(deps, args, {
      status: hasEngineeringChanges ? 'completed_unverified' : 'completed',
      reason: hasEngineeringChanges
        ? 'verification_plan_unavailable'
        : 'verification_not_required',
      stopReason: 'model_done',
      content: sanitizeAssistantContentForUser(response.content),
    });
  }

  const plan = resolution.plan;
  const mustRunPlan = plan.source === 'user'
    || plan.source === 'project' // 旧 checkpoint；新解析不再产出 project
    || (
      plan.source === 'runtime_default'
      && hasEngineeringChanges
      && taskSnap.workspaceMutationVersion > 0
    );
  if (!mustRunPlan) {
    return finishNoToolRound(deps, args, {
      status: hasEngineeringChanges ? 'completed_unverified' : 'completed',
      reason: hasEngineeringChanges
        ? 'verification_plan_unavailable'
        : 'verification_not_required',
      stopReason: 'model_done',
      content: sanitizeAssistantContentForUser(response.content),
    });
  }

  if (isVerificationFresh(state.verificationState, plan.fingerprint)) {
    return finishNoToolRound(deps, args, {
      status: 'completed',
      reason: 'verification_passed',
      stopReason: 'model_done',
      content: sanitizeAssistantContentForUser(response.content),
    });
  }

  // 正文是结束提议；先写入历史，再以同一 deps/Graph/Gate 执行确定性验收。
  pushAssistantForHistory(msgs, response);
  const stopVerification = deps.toolExecutor
    && workspaceRoot
    && currentTools.some(tool => tool.name === 'run_command')
    ? await executeStopVerificationPlan({
        plan,
        taskState: state.taskState,
        verificationState: state.verificationState,
        executeToolCall: createHarnessVerificationToolAdapter({
          deps: deps as ToolExecutorDeps,
          state,
          currentTools,
          logger,
          onStep,
          abortSignal: deps.abortSignal,
          graphExecutor: deps.graphExecutor,
        }),
        abortSignal: deps.abortSignal,
      })
    : {
        status: 'unavailable' as const,
        reason: 'blocked' as const,
        failedCommand: plan.commands[0]?.command,
      };

  if (stopVerification.status === 'passed') {
    return finishNoToolRound(deps, args, {
      status: 'completed',
      reason: 'verification_passed',
      stopReason: 'model_done',
      content: sanitizeAssistantContentForUser(response.content),
      assistantAlreadyRecorded: true,
    });
  }

  if (stopVerification.status === 'aborted') {
    return finishNoToolRound(deps, args, {
      status: 'interrupted',
      reason: 'verification_unavailable',
      stopReason: 'user_abort',
      content: sanitizeAssistantContentForUser(response.content),
      assistantAlreadyRecorded: true,
    });
  }

  if (stopVerification.status === 'failed') {
    if (tryConsumeVerificationContinuation(state.verificationState, 1)) {
      injectContinuationUserMessage(
        deps,
        state,
        msgs,
        buildVerificationContinuationPrompt(stopVerification),
      );
      await saveTaskCheckpoint(
        deps,
        'running',
        resolveCheckpointUserGoal(state, userMessage),
        msgs,
        state,
      );
      await resilienceSaveCheckpoint(deps, 'verification_failed', state);
      state.transition = 'no_tool_execution_recovery';
      return { action: 'continue' };
    }

    const explicit = plan.source === 'user' || plan.source === 'project';
    return finishNoToolRound(deps, args, {
      status: explicit ? 'failed' : 'completed_unverified',
      reason: 'verification_failed',
      stopReason: 'model_done',
      content: appendVerificationFailureNotice(
        sanitizeAssistantContentForUser(response.content),
        stopVerification,
      ),
      assistantAlreadyRecorded: true,
    });
  }

  const explicit = plan.source === 'user' || plan.source === 'project';
  return finishNoToolRound(deps, args, {
    status: explicit ? 'paused' : 'completed_unverified',
    reason: 'verification_unavailable',
    stopReason: explicit ? 'completion_paused' : 'model_done',
    content: sanitizeAssistantContentForUser(response.content),
    assistantAlreadyRecorded: true,
  });
}

function isImplementationIntent(intent: ReturnType<HarnessRunState['taskState']['snapshot']>['intent']): boolean {
  return intent === 'edit'
    || intent === 'debug'
    || intent === 'refactor'
    || intent === 'docs';
}

function buildVerificationContinuationPrompt(
  result: StopVerificationResult,
): string {
  return [
    '[System / Stop Verification] The deterministic acceptance command failed.',
    result.failedCommand ? `Command: ${result.failedCommand}` : '',
    result.exitCode !== undefined ? `Exit code: ${result.exitCode}` : '',
    result.outputTail ? `Relevant output:\n${result.outputTail.slice(-1_200)}` : '',
    'The single stop-verification continuation is now consumed.',
    'Fix the real cause and run only the relevant verification. Do not substitute git diff or directory listings.',
  ].filter(Boolean).join('\n');
}

function appendVerificationFailureNotice(
  content: string,
  result: StopVerificationResult,
): string {
  const command = result.failedCommand ?? 'verification command';
  const exit = result.exitCode !== undefined ? ` (exit code ${result.exitCode})` : '';
  return [content, `Verification still failed: ${command}${exit}.`]
    .filter(Boolean)
    .join('\n\n');
}

async function finishNoToolRound(
  deps: NoToolRoundDeps,
  args: HandleNoToolCallsArgs,
  terminal: {
    status: CompletionStatus;
    reason: CompletionReason;
    stopReason: StopReason;
    content: string;
    assistantAlreadyRecorded?: boolean;
  },
): Promise<HandleNoToolCallsResult> {
  const {
    state,
    response,
    userMessage,
    currentTools,
    tokenUsage,
    logger,
    onStep,
  } = args;
  if (!terminal.assistantAlreadyRecorded) {
    pushAssistantForHistory(state.messages, response);
  }
  if (terminal.stopReason === 'model_done' && deps.graphExecutor?.hasGraph()) {
    const advanced = deps.graphExecutor.advanceOrComplete();
    if (advanced.graphDone) onStep?.({ type: 'task_graph_done' });
  }

  state.completionStatus = terminal.status;
  state.completionReason = terminal.reason;
  emitLightweightSnapshotBoundary({
    boundary: 'gate_decision',
    detail: `${terminal.status}:${terminal.reason}`,
  });
  deps.loopController.stop(terminal.stopReason);
  const finalState = deps.loopController.getState();
  logger.loopStop(
    terminal.stopReason,
    finalState.currentRound,
    finalState.totalToolCalls,
  );
  await saveTaskCheckpoint(
    deps,
    checkpointStatusForCompletion(terminal.status),
    resolveCheckpointUserGoal(state, userMessage),
    state.messages,
    state,
    terminal.stopReason,
  );
  await resilienceSaveCheckpoint(
    deps,
    'final_draft',
    state,
    terminal.stopReason,
  );
  recordTelemetrySummary(deps, terminal.stopReason, state, {
    status: terminal.status,
    reason: terminal.reason,
  });
  onStep?.({
    type: 'final',
    iteration: finalState.currentRound,
    totalToolCalls: finalState.totalToolCalls,
    content: terminal.content,
    stopReason: terminal.stopReason,
    completionStatus: terminal.status,
    completionReason: terminal.reason,
    tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
    totalTokenUsage: buildTotalTokenUsageWithContext(state.messages, currentTools, {
      lastInputTokens: finalState.lastInputTokens,
      lastOutputTokens: finalState.lastOutputTokens,
    }),
  });
  return {
    action: 'return',
    result: {
      content: terminal.content,
      loopState: finalState,
      messages: [...state.messages],
      log: logger.getEntries(),
      completionStatus: terminal.status,
      completionReason: terminal.reason,
    },
  };
}

function checkpointStatusForCompletion(
  status: CompletionStatus,
): 'completed' | 'paused' | 'failed' | 'aborted' {
  if (status === 'completed' || status === 'completed_unverified') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'interrupted') return 'aborted';
  return 'paused';
}
