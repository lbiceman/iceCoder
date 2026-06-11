import type { LLMResponse } from '../llm/types.js';
import { buildTotalTokenUsageWithContext } from './context-usage-display.js';
import { shouldApplyCasualHarness } from './casual-mode.js';
import type { CheckpointDeps } from './harness-checkpoint.js';
import { recordTelemetrySummary, saveTaskCheckpoint } from './harness-checkpoint.js';
import { resolveCheckpointUserGoal } from './session-goal-anchor.js';
import {
  MAX_EMPTY_RESPONSE_RETRIES,
  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  MAX_PREMATURE_COMPLETION_RECOVERY,
  MAX_REASONING_ONLY_RECOVERY,
  MAX_STOP_HOOK_CONTINUATIONS,
  MAX_VERIFICATION_GATE_CONTINUATIONS,
} from './harness-constants.js';
import {
  canVerifyDeliverableKind,
} from './document-deliverable.js';
import type { HarnessMemoryIntegration } from './harness-memory.js';
import {
  getLatestRealUserText,
  hasAssistantToolCallAfterLatestRealUser,
  isActionableToolRequest,
} from './harness-message-utils.js';
import {
  buildIncompleteContinuationPrompt,
  hasPendingWork,
  isReasoningOnlyResponse,
} from './incomplete-completion.js';
import { hasPendingAcceptanceWork } from './task-acceptance-tracker.js';
import { isResumeContinuationMessage } from './resume-goal.js';
import type { ResilienceBridgeDeps } from './harness-resilience.js';
import { resilienceSaveCheckpoint } from './harness-resilience.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type { GraphExecutor } from './task-graph-executor.js';
import { buildToolPlan, formatToolPlan } from './tool-planner.js';
import type { StopHookManager } from './stop-hooks.js';
import type {
  HarnessResult,
  HarnessStepEvent,
} from './types.js';
import type { ToolDefinition } from '../llm/types.js';
import type { UnifiedMessage } from '../llm/types.js';
import type { TaskStateSnapshot } from '../types/runtime-snapshot.js';
import {
  containsEmbeddedToolCalls,
  prepareAssistantContentForHistory,
  sanitizeAssistantContentForUser,
} from './text-tool-call-salvage.js';

function verificationGateHalfPoint(): number {
  return Math.ceil(MAX_VERIFICATION_GATE_CONTINUATIONS / 2);
}

function buildNoToolExecutionRecoveryPrompt(
  msgs: UnifiedMessage[],
  userMessage: string,
  taskSnap: TaskStateSnapshot,
): string {
  return [
    '[System] The user asked for an executable software-engineering action, but you did not invoke tools via the API. Continue now using native function-calling (tool_calls) — do not embed tool invocations as XML/JSON text in your reply.',
    '',
    formatToolPlan(buildToolPlan(getLatestRealUserText(msgs, userMessage), taskSnap)),
  ].join('\n');
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
  deps: NoToolRoundDeps,
  state: HarnessRunState,
  msgs: UnifiedMessage[],
  content: string,
): void {
  const round = deps.loopController.getState().currentRound;
  const bridge = state.supervisorBridge;
  if (bridge?.isActive() && !deps.supervisorObserverSuppressInject) {
    bridge.createCorrectionPort(msgs, round).inject(
      {
        kind: 'recovery',
        content,
        preserveOnCompaction: true,
      },
      { phase: state.supervisorPhase, source: 'lifecycle' },
    );
  } else {
    msgs.push({ role: 'user', content });
  }
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
    && !shouldApplyCasualHarness(state.taskState.snapshot().intent)
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
        buildNoToolExecutionRecoveryPrompt(msgs, userMessage, state.taskState.snapshot()),
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
    deps.loopController.stop('max_output_tokens');
    const finalState = deps.loopController.getState();
    logger.loopStop('max_output_tokens', finalState.currentRound, finalState.totalToolCalls);

    onStep?.({
      type: 'final',
      iteration: finalState.currentRound,
      totalToolCalls: finalState.totalToolCalls,
      content: sanitizeAssistantContentForUser(response.content),
      stopReason: 'max_output_tokens',
      tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
      totalTokenUsage: buildTotalTokenUsageWithContext(msgs, currentTools, {
        lastInputTokens: finalState.lastInputTokens,
        lastOutputTokens: finalState.lastOutputTokens,
      }),
    });

    return {
      action: 'return',
      result: {
        content: sanitizeAssistantContentForUser(response.content),
        loopState: finalState,
        messages: [...msgs],
        log: logger.getEntries(),
      },
    };
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
      content: 'You must call tools to continue the task. Do not stop with thinking only — run verification or edit files now.',
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
        undefined,
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
    deps.loopController.stop('error');
    const finalState = deps.loopController.getState();
    logger.loopStop('error', finalState.currentRound, finalState.totalToolCalls);

    onStep?.({
      type: 'final',
      iteration: finalState.currentRound,
      totalToolCalls: finalState.totalToolCalls,
      content: 'LLM returned empty response',
      stopReason: 'error',
    });

    return {
      action: 'return',
      result: {
        content: 'LLM returned empty response, please retry.',
        loopState: finalState,
        messages: [...msgs],
        log: logger.getEntries(),
      },
    };
  }

  state.emptyResponseRetryCount = 0;

  // 删除/cleanup 后同步 filesChanged，避免 Gate 仍要求 read 已不存在的文件
  state.taskState.reconcileMissingChangedFiles(deps.workspaceRoot);
  state.repoContext.reconcileMissingChangedFiles(deps.workspaceRoot);

  const taskSnap = state.taskState.snapshot();
  const repoSnap = state.repoContext.snapshot();
  const workspaceRoot = deps.workspaceRoot;
  const acceptanceIncomplete = hasPendingAcceptanceWork(state.taskAcceptance);
  const pendingWork = hasPendingWork(taskSnap, state.taskAcceptance, workspaceRoot);
  const latestUserText = getLatestRealUserText(msgs, userMessage);
  const resumeWithPending = isResumeContinuationMessage(latestUserText) && pendingWork;
  const hasToolCallSinceUser = hasAssistantToolCallAfterLatestRealUser(msgs);

  // 状态门控：以下任一成立 → 跳过 stop hook
  // 1) 问答 / 查看类意图（casual harness）
  // 2) 已有写文件变更（Gate / prematureCompletion 接管收尾验收）
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
        deps.loopController.stop('stop_hook');
        const finalState = deps.loopController.getState();
        logger.loopStop('stop_hook', finalState.currentRound, finalState.totalToolCalls);

        onStep?.({
          type: 'final',
          iteration: finalState.currentRound,
          totalToolCalls: finalState.totalToolCalls,
          content: sanitizeAssistantContentForUser(response.content),
          stopReason: 'stop_hook',
        });

        return {
          action: 'return',
          result: {
            content: sanitizeAssistantContentForUser(response.content),
            loopState: finalState,
            messages: [...msgs],
            log: logger.getEntries(),
          },
        };
      }

      console.log(`[harness] 停止钩子 "${hookResult.hookName}" 要求继续 (${state.stopHookContinuationCount}/${MAX_STOP_HOOK_CONTINUATIONS})`);
      msgs.push({ role: 'user', content: hookResult.message });
      state.transition = 'stop_hook_continue';
      return { action: 'continue' };
    }
  }

  // verification gate：单元测试提示 / Acceptance Gate pending 时优先于 no_tool recovery
  const toolNames = currentTools.map(t => t.name);
  const canVerifyDeliverable = canVerifyDeliverableKind(
    taskSnap.filesChanged,
    toolNames,
    acceptanceIncomplete,
    taskSnap.verificationStatus,
  );
  let blockVerification = state.taskState.isVerificationBlockingFinal(acceptanceIncomplete, workspaceRoot);

  const returnVerificationExhausted = (detail?: string): HandleNoToolCallsResult => {
    const defaultSuffix = canVerifyDeliverable
      ? '\n任务因验收无法继续而暂停：已连续多轮未调用 run_command 完成单元测试。'
      : '\n任务因验收无法继续而暂停：当前工具集缺少验收所需工具。';
    const suffix = detail ? `\n${detail}` : defaultSuffix;
    const content = sanitizeAssistantContentForUser(response.content) + suffix;
    pushAssistantForHistory(msgs, response);
    deps.loopController.stop('verification_exhausted');
    const finalState = deps.loopController.getState();
    logger.loopStop('verification_exhausted', finalState.currentRound, finalState.totalToolCalls);
    onStep?.({
      type: 'final',
      iteration: finalState.currentRound,
      totalToolCalls: finalState.totalToolCalls,
      content,
      stopReason: 'verification_exhausted',
    });
    return {
      action: 'return',
      result: {
        content,
        loopState: finalState,
        messages: [...msgs],
        log: logger.getEntries(),
      },
    };
  };

  if (!blockVerification) {
    state.verificationGateContinuationCount = 0;
  } else if (!canVerifyDeliverable) {
    console.log('[harness] 验收仍 pending 但当前轮次无可用验收工具，强制结束');
    return returnVerificationExhausted(
      acceptanceIncomplete
        ? 'Acceptance Gate 需要 run_command，但当前工具集不可用。'
        : '工程源码变更需要 run_command 跑单元测试，但当前工具集不可用。',
    );
  } else if (blockVerification) {
    if (state.verificationGateContinuationCount >= MAX_VERIFICATION_GATE_CONTINUATIONS) {
      console.log('[harness] verification gate 连续注入已达上限，强制结束');
      return returnVerificationExhausted();
    } else {
      state.verificationGateContinuationCount++;
      console.log(
        `[harness] verification gate 注入 (${state.verificationGateContinuationCount}/${MAX_VERIFICATION_GATE_CONTINUATIONS})`,
      );
      pushAssistantForHistory(msgs, response);
      let prompt: string;
      if (acceptanceIncomplete && state.taskAcceptance) {
        prompt = state.taskAcceptance.buildAcceptancePrompt();
      } else {
        prompt = state.taskState.buildVerificationPrompt();
      }
      const injectionParts = [
        prompt,
        '',
        formatToolPlan(buildToolPlan(getLatestRealUserText(msgs, userMessage), state.taskState.snapshot(), workspaceRoot)),
      ];
      if (state.verificationGateContinuationCount === verificationGateHalfPoint()) {
        console.log('[harness] verification gate 半程叠加 no_tool 强提示');
        injectionParts.push('', buildNoToolExecutionRecoveryPrompt(msgs, userMessage, taskSnap));
      }
      injectContinuationUserMessage(deps, state, msgs, injectionParts.join('\n'));
      await resilienceSaveCheckpoint(deps, 'verification_started', state);
      state.transition = 'stop_hook_continue';
      return { action: 'continue' };
    }
  }

  if (
    !blockVerification
    && !state.failedUnitTestReminderInjected
    && state.taskState.shouldInjectFailedUnitTestReminder()
  ) {
    state.failedUnitTestReminderInjected = true;
    console.log('[harness] 单测失败加强提示 inject（不 hard block）');
    pushAssistantForHistory(msgs, response);
    injectContinuationUserMessage(deps, state, msgs, [
      state.taskState.buildFailedUnitTestReminderPrompt(),
      '',
      formatToolPlan(buildToolPlan(getLatestRealUserText(msgs, userMessage), state.taskState.snapshot(), workspaceRoot)),
    ].join('\n'));
    state.transition = 'stop_hook_continue';
    return { action: 'continue' };
  }

  if (
    currentTools.length > 0
    && state.noToolExecutionRecoveryCount < 1
    && state.stopHookContinuationCount === 0
    && (
      hasEmbeddedToolText
      || (
        !hasAssistantToolCallAfterLatestRealUser(msgs)
        && (
          containsEmbeddedToolCalls(response.content)
          || (isActionableToolRequest(latestUserText) && !shouldApplyCasualHarness(taskSnap.intent))
          || resumeWithPending
          || (pendingWork && taskSnap.intent !== 'question' && taskSnap.intent !== 'inspect')
        )
      )
    )
  ) {
    state.noToolExecutionRecoveryCount++;
    pushAssistantForHistory(msgs, response);
    msgs.push({
      role: 'user',
      content: buildNoToolExecutionRecoveryPrompt(msgs, userMessage, taskSnap),
    });
    state.transition = 'no_tool_execution_recovery';
    return { action: 'continue' };
  }

  if (
    pendingWork
    && state.prematureCompletionRecoveryCount < MAX_PREMATURE_COMPLETION_RECOVERY
  ) {
    state.prematureCompletionRecoveryCount++;
    console.log(
      `[harness] 验收/诊断未清，拦截 model_done (${state.prematureCompletionRecoveryCount}/${MAX_PREMATURE_COMPLETION_RECOVERY})`,
    );
    pushAssistantForHistory(msgs, response);
    injectContinuationUserMessage(deps, state, msgs, [
      buildIncompleteContinuationPrompt(taskSnap, repoSnap, state.taskAcceptance, workspaceRoot),
      '',
      formatToolPlan(buildToolPlan(getLatestRealUserText(msgs, userMessage), taskSnap, workspaceRoot)),
    ].join('\n'));
    await saveTaskCheckpoint(deps, 'paused', resolveCheckpointUserGoal(state, userMessage), msgs, state, 'model_done');
    await resilienceSaveCheckpoint(deps, 'verification_started', state);
    state.transition = 'no_tool_execution_recovery';
    return { action: 'continue' };
  }

  if (pendingWork) {
    console.log('[harness] 验收未清，拒绝 model_done');
    return returnVerificationExhausted('任务仍有未完成的验收项。');
  }

  state.stopHookContinuationCount = 0;

  if (deps.graphExecutor?.hasGraph()) {
    const ar = deps.graphExecutor.advanceOrComplete();
    if (ar.graphDone) {
      onStep?.({ type: 'task_graph_done' });
    }
  }

  const checkpointStatus = pendingWork ? 'paused' : 'completed';
  deps.loopController.stop('model_done');
  const finalState = deps.loopController.getState();
  logger.loopStop('model_done', finalState.currentRound, finalState.totalToolCalls);
  await saveTaskCheckpoint(deps, checkpointStatus, resolveCheckpointUserGoal(state, userMessage), msgs, state, 'model_done');
  await resilienceSaveCheckpoint(deps, 'final_draft', state, 'model_done');
  recordTelemetrySummary(deps, 'model_done', state);

  onStep?.({
    type: 'final',
    iteration: finalState.currentRound,
    totalToolCalls: finalState.totalToolCalls,
    content: sanitizeAssistantContentForUser(response.content),
    stopReason: 'model_done',
    tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
    totalTokenUsage: buildTotalTokenUsageWithContext(msgs, currentTools, {
      lastInputTokens: finalState.lastInputTokens,
      lastOutputTokens: finalState.lastOutputTokens,
    }),
  });

  return {
    action: 'return',
    result: {
      content: sanitizeAssistantContentForUser(response.content),
      loopState: finalState,
      messages: [...msgs],
      log: logger.getEntries(),
    },
  };
}
