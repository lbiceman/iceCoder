import type { LLMResponse } from '../llm/types.js';
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
} from './harness-constants.js';
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

export interface NoToolRoundDeps extends CheckpointDeps, ResilienceBridgeDeps {
  loopController: LoopController;
  memoryIntegration: HarnessMemoryIntegration;
  stopHookManager: StopHookManager;
  graphExecutor: GraphExecutor;
}

export interface HandleNoToolCallsArgs {
  state: HarnessRunState;
  response: LLMResponse;
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
  const { state, response, userMessage, currentTools, tokenUsage, logger, onStep } = args;
  const msgs = state.messages;
  state.consecutiveNoToolRounds++;

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
        msgs.push({ role: 'assistant', content: response.content });
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

    if (response.content) {
      msgs.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
    }
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
      content: response.content,
      stopReason: 'max_output_tokens',
      tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
      totalTokenUsage: {
        inputTokens: finalState.lastInputTokens,
        outputTokens: finalState.lastOutputTokens,
      },
    });

    return {
      action: 'return',
      result: {
        content: response.content,
        loopState: finalState,
        messages: [...msgs],
        log: logger.getEntries(),
      },
    };
  }

  if (
    ((!response.content || !response.content.trim()) || isReasoningOnlyResponse(response))
    && state.emptyResponseRetryCount < MAX_EMPTY_RESPONSE_RETRIES
  ) {
    state.emptyResponseRetryCount++;
    console.log(
      `[harness] LLM 空响应/仅思考重试 (${state.emptyResponseRetryCount}/${MAX_EMPTY_RESPONSE_RETRIES})`,
    );
    if (response.content || response.reasoningContent) {
      msgs.push({
        role: 'assistant',
        content: response.content || '',
        reasoningContent: response.reasoningContent,
      });
    }
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
      role: 'assistant',
      content: response.content || '',
      reasoningContent: response.reasoningContent,
    });
    msgs.push({
      role: 'user',
      content: buildIncompleteContinuationPrompt(
        state.taskState.snapshot(),
        state.repoContext.snapshot(),
      ),
    });
    state.transition = 'no_tool_execution_recovery';
    return { action: 'continue' };
  }

  if (
    (!response.content || !response.content.trim())
    && !response.reasoningContent?.trim()
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

  const taskSnap = state.taskState.snapshot();
  const repoSnap = state.repoContext.snapshot();
  const acceptanceIncomplete = hasPendingAcceptanceWork(state.taskAcceptance);
  const pendingWork = hasPendingWork(taskSnap, repoSnap, state.taskAcceptance);
  const latestUserText = getLatestRealUserText(msgs, userMessage);
  const resumeWithPending = isResumeContinuationMessage(latestUserText) && pendingWork;
  const hasToolCallSinceUser = hasAssistantToolCallAfterLatestRealUser(msgs);

  // 状态门控：以下任一成立 → 跳过 stop hook
  // 1) 问答 / 查看类意图（casual harness）
  // 2) 文档类意图（写 README / 总结类）
  // 3) 没有遗留工作且本轮已经动过工具 → 任务自然完成
  // prematureCompletionRecovery 会接管真正有 pendingWork 的早停场景。
  const skipStopHook =
    shouldApplyCasualHarness(taskSnap.intent)
    || taskSnap.intent === 'docs'
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
          content: response.content,
          stopReason: 'stop_hook',
        });

        return {
          action: 'return',
          result: {
            content: response.content,
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

  if (
    currentTools.length > 0
    && !hasAssistantToolCallAfterLatestRealUser(msgs)
    && state.noToolExecutionRecoveryCount < 1
    && state.stopHookContinuationCount === 0
    && (
      (isActionableToolRequest(latestUserText) && !shouldApplyCasualHarness(taskSnap.intent))
      || resumeWithPending
      || (pendingWork && taskSnap.intent !== 'question' && taskSnap.intent !== 'inspect')
    )
  ) {
    state.noToolExecutionRecoveryCount++;
    if (response.content) {
      msgs.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
    }
    msgs.push({
      role: 'user',
      content: [
        '[System] The user asked for an executable software-engineering action, but you did not call any tools. Continue now by calling the appropriate tool(s) to inspect, modify, run, test, or verify as needed. Do not answer with a plan or promise unless the task is impossible.',
        '',
        formatToolPlan(buildToolPlan(getLatestRealUserText(msgs, userMessage), state.taskState.snapshot())),
      ].join('\n'),
    });
    state.transition = 'no_tool_execution_recovery';
    return { action: 'continue' };
  }

  // verification gate：当任务还有未验证的工程动作时拉回 LLM 调工具。
  // 状态门控的关键防线在 `syncHydratedTaskState`（{@link isFreshQueryMessage}）：
  // 新查询会清掉旧 filesChanged / verificationStatus，避免 gate 误把无关问答轮拉回。
  const canRunVerification = currentTools.some(t => t.name === 'run_command');
  if (
    canRunVerification
    && state.taskState.shouldBlockFinalForVerification(acceptanceIncomplete)
  ) {
    if (response.content) {
      msgs.push({ role: 'assistant', content: response.content, reasoningContent: response.reasoningContent });
    } else if (response.reasoningContent) {
      msgs.push({ role: 'assistant', content: '', reasoningContent: response.reasoningContent });
    }
    const prompt = acceptanceIncomplete && state.taskAcceptance
      ? state.taskAcceptance.buildAcceptancePrompt()
      : state.taskState.buildVerificationPrompt();
    injectContinuationUserMessage(deps, state, msgs, [
      prompt,
      '',
      formatToolPlan(buildToolPlan(getLatestRealUserText(msgs, userMessage), state.taskState.snapshot())),
    ].join('\n'));
    await resilienceSaveCheckpoint(deps, 'verification_started', state);
    state.transition = 'stop_hook_continue';
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
    if (response.content || response.reasoningContent) {
      msgs.push({
        role: 'assistant',
        content: response.content || '',
        reasoningContent: response.reasoningContent,
      });
    }
    injectContinuationUserMessage(deps, state, msgs, [
      buildIncompleteContinuationPrompt(taskSnap, repoSnap, state.taskAcceptance),
      '',
      formatToolPlan(buildToolPlan(getLatestRealUserText(msgs, userMessage), taskSnap)),
    ].join('\n'));
    await saveTaskCheckpoint(deps, 'paused', resolveCheckpointUserGoal(state, userMessage), msgs, state, 'model_done');
    await resilienceSaveCheckpoint(deps, 'verification_started', state);
    state.transition = 'no_tool_execution_recovery';
    return { action: 'continue' };
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
    content: response.content,
    stopReason: 'model_done',
    tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
    totalTokenUsage: {
      inputTokens: finalState.lastInputTokens,
      outputTokens: finalState.lastOutputTokens,
    },
  });

  return {
    action: 'return',
    result: {
      content: response.content,
      loopState: finalState,
      messages: [...msgs],
      log: logger.getEntries(),
    },
  };
}
