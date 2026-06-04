import type { UnifiedMessage, ToolDefinition } from '../llm/types.js';
import type { CheckpointDeps } from './harness-checkpoint.js';
import { recordTelemetrySummary, saveTaskCheckpoint } from './harness-checkpoint.js';
import { buildLlmRoundLogFields } from './harness-llm-log.js';
import { resolveCheckpointUserGoal } from './session-goal-anchor.js';
import type { ResilienceBridgeDeps } from './harness-resilience.js';
import { resilienceSaveCheckpoint } from './harness-resilience.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type {
  ChatFunction,
  HarnessResult,
  HarnessStepEvent,
  StopReason,
  StreamFunction,
} from './types.js';
import {
  resolveSalvagedLlmResponse,
  sanitizeAssistantContentForUser,
  AssistantVisibleStreamFilter,
} from './text-tool-call-salvage.js';
import { dispatchStreamChunkToStep } from './stream-step-dispatch.js';

export interface StopHandlerDeps extends CheckpointDeps, ResilienceBridgeDeps {
  loopController: LoopController;
}

export interface HandleHarnessStopArgs {
  reason: StopReason;
  messages: UnifiedMessage[];
  chatFn: ChatFunction;
  tools: ToolDefinition[];
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
  streamFn?: StreamFunction;
  runtimeState?: HarnessRunState;
}

/**
 * 处理循环停止：请求 LLM 给出最终总结。
 */
export async function handleHarnessStop(
  deps: StopHandlerDeps,
  args: HandleHarnessStopArgs,
): Promise<HarnessResult> {
  const { reason, messages, chatFn, logger, onStep, streamFn, runtimeState } = args;

  deps.loopController.stop(reason);
  const state = deps.loopController.getState();
  logger.loopStop(reason, state.currentRound, state.totalToolCalls);
  // currentPlanTracker.onFinal removed (Phase 11)
  await saveTaskCheckpoint(
    deps,
    reason === 'user_abort' ? 'aborted' : reason === 'error' ? 'failed' : 'paused',
    resolveCheckpointUserGoal(runtimeState, ''),
    messages,
    runtimeState,
    reason,
  );
  await resilienceSaveCheckpoint(deps, 'final_draft', runtimeState, reason);
  if (runtimeState) recordTelemetrySummary(deps, reason, runtimeState);

  // 如果是用户中断，直接返回
  if (reason === 'user_abort') {
    onStep?.({ type: 'final', stopReason: reason, totalToolCalls: state.totalToolCalls });
    return {
      content: '',
      loopState: state,
      messages: [...messages],
      log: logger.getEntries(),
    };
  }

  if (reason === 'token_budget') {
    const finalContent = [
      '任务因 token 预算耗尽而暂停，尚未确认完成。',
      `已执行 ${state.currentRound} 轮、${state.totalToolCalls} 次工具调用。`,
      '请拆分任务或发起新会话后重试。',
    ].join('\n');

    onStep?.({
      type: 'final',
      totalToolCalls: state.totalToolCalls,
      content: finalContent,
      stopReason: reason,
    });

    return {
      content: finalContent,
      loopState: state,
      messages: [...messages],
      log: logger.getEntries(),
    };
  }

  if (reason === 'user_checkpoint') {
    const finalContent = [
      'Supervisor 已暂停自动恢复（恢复预算用尽或需人工决策）。',
      `已执行 ${state.currentRound} 轮、${state.totalToolCalls} 次工具调用。`,
      '任务已保存为 paused，你可以补充说明后继续对话，或调整思路后重试。',
    ].join('\n');

    onStep?.({
      type: 'final',
      totalToolCalls: state.totalToolCalls,
      content: finalContent,
      stopReason: reason,
    });

    return {
      content: finalContent,
      loopState: state,
      messages: [...messages],
      log: logger.getEntries(),
    };
  }

  // 其他原因：请求 LLM 总结
  logger.llmCall();
  messages.push({
    role: 'user',
    content: 'Please provide a final summary answer based on the tool call results above.',
  });

  let finalContent = '';
  try {
    // 优先使用流式调用，让前端实时看到总结内容
    if (streamFn) {
      const streamFilter = new AssistantVisibleStreamFilter();
      const finalResponse = await streamFn(messages, (chunk, done) => {
        dispatchStreamChunkToStep(
          chunk,
          done,
          streamFilter,
          state.currentRound,
          onStep,
        );
      }, { tools: [] });
      const tail = streamFilter.flush();
      if (tail) {
        onStep?.({ type: 'stream_delta', iteration: state.currentRound, delta: tail });
      }
      finalContent = resolveSalvagedLlmResponse(finalResponse).content ?? finalResponse.content;
      const sumLog = buildLlmRoundLogFields(messages, finalResponse.usage);
      logger.llmResponseFinal(sumLog.usage, sumLog.meta);
    } else {
      const finalResponse = await chatFn(messages, { tools: [] });
      finalContent = resolveSalvagedLlmResponse(finalResponse).content ?? finalResponse.content;
      const sumLog = buildLlmRoundLogFields(messages, finalResponse.usage);
      logger.llmResponseFinal(sumLog.usage, sumLog.meta);
    }
  } catch (err) {
    // 最终总结调用失败，用最后一条 assistant 消息作为回复
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant' && m.content);
    finalContent = typeof lastAssistant?.content === 'string'
      ? sanitizeAssistantContentForUser(lastAssistant.content)
      : `任务因 ${reason} 停止，最终总结生成失败。`;
    logger.error(`最终总结 LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  finalContent = sanitizeAssistantContentForUser(finalContent);

  onStep?.({
    type: 'final',
    totalToolCalls: state.totalToolCalls,
    content: finalContent,
    stopReason: reason,
  });

  return {
    content: finalContent,
    loopState: state,
    messages: [...messages],
    log: logger.getEntries(),
  };
}
