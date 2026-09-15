import type {
  UnifiedMessage,
  ToolDefinition,
  LLMResponse,
} from '../llm/types.js';
import {
  LLM_MAX_RETRIES,
  LLM_RETRY_BASE_DELAY,
  LLM_RETRY_MAX_DELAY,
} from './harness-constants.js';
import { buildLlmRoundLogFields, isRetryableError } from './harness-llm-log.js';
import { isAbortError } from '../llm/abort-error.js';
import { AssistantVisibleStreamFilter } from './text-tool-call-salvage.js';
import { dispatchStreamChunkToStep } from './stream-step-dispatch.js';
import { ReasoningSystemTagStreamFilter } from './thinking-content-strip.js';
import {
  applyCheckpointResumeFork,
  buildEmergencyResumeSummaryMessage,
  isContextWindowExceededError,
  isToolCallPairingError,
} from './checkpoint-resume-compact.js';
import { finalizeMessagesForApi } from './context-assembler.js';
import { logCacheSegmentReset } from './harness-cache-segment.js';
import { PROACTIVE_FORK_RATIO } from './compaction-constants.js';
import { resolveCompactionUsage } from '../llm/token-estimator.js';
import { readEffectiveContextWindowTokens } from './context-window-tier.js';
import type { HarnessRunState } from './harness-run-state.js';
import { canUseEmergencyCompact, consumeEmergencyCompact } from './emergency-compact-quota.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type { TokenBudgetTracker } from './token-budget.js';
import type { RuntimeTelemetry } from './runtime-telemetry.js';
import type { ContextCompactor } from './context-compactor.js';
import type {
  ChatFunction,
  HarnessResult,
  HarnessStepEvent,
  StreamFunction,
} from './types.js';
import { endTiming, markTimingStart, timeSync } from './harness-timing.js';
import { isStreamIdleTimeoutError } from '../llm/stream-idle-watchdog.js';

export interface LlmCallDeps {
  loopController: LoopController;
  tokenBudgetTracker?: TokenBudgetTracker;
  runtimeTelemetry?: RuntimeTelemetry;
  contextCompactor?: ContextCompactor;
  sessionId?: string;
}

export interface CallHarnessLlmArgs {
  state: HarnessRunState;
  normalizedMsgs: UnifiedMessage[];
  currentTools: ToolDefinition[];
  round: number;
  chatFn: ChatFunction;
  streamFn?: StreamFunction;
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
}

export type CallHarnessLlmResult =
  | {
    action: 'response';
    response: LLMResponse;
    llmRoundLog: ReturnType<typeof buildLlmRoundLogFields>;
    tokenUsage: { input: number; output: number };
  }
  | { action: 'retry' }
  | { action: 'abort' }
  | { action: 'error'; result: HarnessResult };

/**
 * 调用 LLM（流式/非流式、重试、中断检查）。
 */
export async function callHarnessLlm(
  deps: LlmCallDeps,
  args: CallHarnessLlmArgs,
): Promise<CallHarnessLlmResult> {
  const { state, normalizedMsgs, currentTools, round, chatFn, streamFn, logger, onStep } = args;

  // 注入后 token 可能再次逼近窗口 — 调用 API 前主动收缩（与 emergency fork 共用一次性配额）
  const precheckStartedAt = markTimingStart();
  if (
    deps.contextCompactor
    && canUseEmergencyCompact(state)
    && !deps.loopController.isAborted()
  ) {
    const ctxWindow = readEffectiveContextWindowTokens();
    const proactiveLine = Math.floor(ctxWindow * PROACTIVE_FORK_RATIO);
    const usage = resolveCompactionUsage({
      messages: normalizedMsgs,
      tools: currentTools,
      lastApiPromptTokens: deps.loopController.getState().lastInputTokens,
    });
    if (usage.effectiveUsed >= proactiveLine) {
      consumeEmergencyCompact(state);
      state.checkpointResumeForkApplied = true;
      const summary = buildEmergencyResumeSummaryMessage(state.activeCheckpointResumeSummary);
      const fork = applyCheckpointResumeFork(deps.contextCompactor, state.messages, summary, {
        aggressive: true,
      });
      logger.error(
        `Context near limit before LLM call; proactive compact ${fork.beforeMessages}→${fork.afterMessages} msgs, retrying`,
      );
      deps.runtimeTelemetry?.recordCompaction({
        beforeMessages: fork.beforeMessages,
        afterMessages: fork.afterMessages,
        beforeTokens: fork.beforeTokens,
        afterTokens: fork.afterTokens,
      });
      logCacheSegmentReset(state.turnCount, 'proactive-fork-pre-llm');
      deps.loopController.rewindRound();
      state.turnCount--;
      state.transition = 'compaction_retry';
      return { action: 'retry' };
    }
  }
  endTiming('llm_precheck', precheckStartedAt, round);

  let response: LLMResponse;
  const llmOpts: {
    tools: ToolDefinition[];
    signal?: AbortSignal;
    sessionId?: string;
    skipRetry: boolean;
  } = {
    tools: currentTools,
    signal: deps.loopController.getAbortSignal(),
    // Harness 是生产执行链的唯一重试负责人，避免 LLMAdapter × Harness 乘法重试。
    skipRetry: true,
    ...(deps.sessionId ? { sessionId: deps.sessionId } : {}),
  };
  try {
    if (streamFn) {
      const streamFilter = new AssistantVisibleStreamFilter();
      const reasoningSanitizer = new ReasoningSystemTagStreamFilter();
      let streamedAny = false;
      try {
        const llmWaitStartedAt = markTimingStart();
        response = await streamFn(normalizedMsgs, (chunk, done) => {
          if (deps.loopController.isAborted()) return;
          if (typeof chunk === 'string' ? chunk.length > 0 : !!chunk) {
            streamedAny = true;
          }
          dispatchStreamChunkToStep(chunk, done, streamFilter, round, onStep, reasoningSanitizer);
        }, llmOpts);
        endTiming('llm_wait', llmWaitStartedAt, round);
        timeSync('llm_stream_filter', () => {
          const tail = streamFilter.flush();
          if (tail.thinking) {
            streamedAny = true;
            onStep?.({ type: 'reasoning_stream_delta', iteration: round, delta: tail.thinking });
          }
          const reasoningTail = reasoningSanitizer.flush();
          if (reasoningTail) {
            streamedAny = true;
            onStep?.({ type: 'reasoning_stream_delta', iteration: round, delta: reasoningTail });
          }
          if (tail.visible) {
            streamedAny = true;
            onStep?.({ type: 'stream_delta', iteration: round, delta: tail.visible });
          }
        }, round);
      } catch (streamError) {
        const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
        if (errMsg.includes('reasoning_content') || errMsg.includes('Failed to deserialize')) {
          console.log('[harness] 流式调用失败，回退到非流式: ' + errMsg.substring(0, 100));
          const llmWaitStartedAt = markTimingStart();
          response = await chatFn(normalizedMsgs, llmOpts);
          endTiming('llm_wait', llmWaitStartedAt, round);
        } else {
          if (streamedAny) {
            onStep?.({ type: 'stream_retry_discard', iteration: round });
          }
          throw streamError;
        }
      }
      if (deps.loopController.isAborted()) {
        return { action: 'abort' };
      }
    } else {
      const llmWaitStartedAt = markTimingStart();
      response = await chatFn(normalizedMsgs, llmOpts);
      endTiming('llm_wait', llmWaitStartedAt, round);
    }
    state.llmRetryCount = 0;
  } catch (error) {
    // 用户中断：abort error 直接走 abort 路径，跳过重试 / 紧急压缩 / error final，
    // 让上层 round 立刻进入 handleHarnessStop(reason='user_abort')。
    if (isAbortError(error) || deps.loopController.isAborted()) {
      return { action: 'abort' };
    }

    const pairingBroken = isToolCallPairingError(error);
    if (
      (isContextWindowExceededError(error) || pairingBroken)
      && canUseEmergencyCompact(state)
      && deps.contextCompactor
      && !deps.loopController.isAborted()
    ) {
      consumeEmergencyCompact(state);
      state.checkpointResumeForkApplied = true;
      if (pairingBroken) {
        const repaired = finalizeMessagesForApi(state.messages);
        state.messages.length = 0;
        state.messages.push(...repaired);
        logger.error(
          `LLM tool-call pairing error; repaired message list (${repaired.length} msgs), retrying`,
        );
        logCacheSegmentReset(state.turnCount, 'emergency-pairing-repair');
      } else {
        const summary = buildEmergencyResumeSummaryMessage(state.activeCheckpointResumeSummary);
        const fork = applyCheckpointResumeFork(deps.contextCompactor, state.messages, summary, {
          aggressive: true,
        });
        logger.error(
          `LLM context window exceeded; emergency compact ${fork.beforeMessages}→${fork.afterMessages} msgs, retrying`,
        );
        deps.runtimeTelemetry?.recordCompaction({
          beforeMessages: fork.beforeMessages,
          afterMessages: fork.afterMessages,
          beforeTokens: fork.beforeTokens,
          afterTokens: fork.afterTokens,
        });
        logCacheSegmentReset(state.turnCount, 'emergency-fork');
      }
      deps.loopController.rewindRound();
      state.turnCount--;
      state.transition = 'compaction_retry';
      return { action: 'retry' };
    }

    const maxRetries = isStreamIdleTimeoutError(error) ? 1 : LLM_MAX_RETRIES;
    if (isRetryableError(error) && state.llmRetryCount < maxRetries && !deps.loopController.isAborted()) {
      state.llmRetryCount++;
      const delay = Math.min(
        LLM_RETRY_BASE_DELAY * Math.pow(2, state.llmRetryCount - 1),
        LLM_RETRY_MAX_DELAY,
      );
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`LLM 调用失败 (${state.llmRetryCount}/${maxRetries}): ${errorMsg}，${delay}ms 后重试`);
      await waitForRetry(delay, deps.loopController.getAbortSignal());
      state.transition = 'llm_error_retry';
      deps.loopController.rewindRound();
      state.turnCount--;
      return { action: 'retry' };
    }

    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`LLM 调用失败且无法恢复: ${errorMsg}`);
    deps.loopController.stop('error');
    const finalState = deps.loopController.getState();
    logger.loopStop('error', finalState.currentRound, finalState.totalToolCalls);

    onStep?.({
      type: 'final',
      iteration: finalState.currentRound,
      totalToolCalls: finalState.totalToolCalls,
      content: `LLM 调用错误: ${errorMsg}`,
      stopReason: 'error',
    });

    return {
      action: 'error',
      result: {
        content: `LLM 调用错误: ${errorMsg}`,
        loopState: finalState,
        messages: [...state.messages],
        log: logger.getEntries(),
      },
    };
  }

  const tokenUsage = {
    input: response.usage?.inputTokens ?? 0,
    output: response.usage?.outputTokens ?? 0,
  };
  const llmRoundLog = buildLlmRoundLogFields(normalizedMsgs, response.usage);
  deps.loopController.recordTokenUsage(tokenUsage.input, tokenUsage.output);
  deps.runtimeTelemetry?.recordRound({
    round,
    task: state.taskState.snapshot(),
    repo: state.repoContext.snapshot(),
    tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
  });

  if (deps.tokenBudgetTracker) {
    deps.tokenBudgetTracker.recordUsage(tokenUsage.input, tokenUsage.output);
  }

  return { action: 'response', response, llmRoundLog, tokenUsage };
}

/** 可中断的重试等待；结束时同时清理 timer 和 AbortSignal listener。 */
function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    if (signal?.aborted) {
      finish();
      return;
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}
