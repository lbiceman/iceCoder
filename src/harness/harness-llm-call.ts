import type { UnifiedMessage, ToolDefinition } from '../llm/types.js';
import type { LLMResponse } from '../llm/types.js';
import {
  LLM_MAX_RETRIES,
  LLM_RETRY_BASE_DELAY,
  LLM_RETRY_MAX_DELAY,
} from './harness-constants.js';
import { buildLlmRoundLogFields, isRetryableError } from './harness-llm-log.js';
import { isAbortError } from '../llm/abort-error.js';
import {
  applyCheckpointResumeFork,
  buildEmergencyResumeSummaryMessage,
  isContextWindowExceededError,
} from './checkpoint-resume-compact.js';
import type { HarnessRunState } from './harness-run-state.js';
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

export interface LlmCallDeps {
  loopController: LoopController;
  tokenBudgetTracker?: TokenBudgetTracker;
  runtimeTelemetry?: RuntimeTelemetry;
  contextCompactor?: ContextCompactor;
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

  let response: LLMResponse;
  try {
    if (streamFn) {
      try {
        response = await streamFn(normalizedMsgs, (chunk, done) => {
          if (deps.loopController.isAborted()) return;
          if (!done && chunk) {
            onStep?.({ type: 'stream_delta', iteration: round, delta: chunk });
          }
        }, { tools: currentTools });
      } catch (streamError) {
        const errMsg = streamError instanceof Error ? streamError.message : String(streamError);
        if (errMsg.includes('reasoning_content') || errMsg.includes('Failed to deserialize')) {
          console.log('[harness] 流式调用失败，回退到非流式: ' + errMsg.substring(0, 100));
          response = await chatFn(normalizedMsgs, { tools: currentTools });
        } else {
          throw streamError;
        }
      }
      if (deps.loopController.isAborted()) {
        return { action: 'abort' };
      }
    } else {
      response = await chatFn(normalizedMsgs, { tools: currentTools });
    }
    state.llmRetryCount = 0;
  } catch (error) {
    // 用户中断：abort error 直接走 abort 路径，跳过重试 / 紧急压缩 / error final，
    // 让上层 round 立刻进入 handleHarnessStop(reason='user_abort')。
    if (isAbortError(error) || deps.loopController.isAborted()) {
      return { action: 'abort' };
    }

    if (
      isContextWindowExceededError(error)
      && !state.contextEmergencyCompactUsed
      && deps.contextCompactor
      && !deps.loopController.isAborted()
    ) {
      state.contextEmergencyCompactUsed = true;
      state.checkpointResumeForkApplied = true;
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
      deps.loopController.rewindRound();
      state.turnCount--;
      state.transition = 'compaction_retry';
      return { action: 'retry' };
    }

    if (isRetryableError(error) && state.llmRetryCount < LLM_MAX_RETRIES && !deps.loopController.isAborted()) {
      state.llmRetryCount++;
      const delay = Math.min(
        LLM_RETRY_BASE_DELAY * Math.pow(2, state.llmRetryCount - 1),
        LLM_RETRY_MAX_DELAY,
      );
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`LLM 调用失败 (${state.llmRetryCount}/${LLM_MAX_RETRIES}): ${errorMsg}，${delay}ms 后重试`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        const checkAbort = () => { clearTimeout(timer); resolve(); };
        if (deps.loopController.isAborted()) { checkAbort(); return; }
        const interval = setInterval(() => {
          if (deps.loopController.isAborted()) { clearInterval(interval); checkAbort(); }
        }, 500);
        const origResolve = resolve;
        resolve = () => { clearInterval(interval); origResolve(); };
      });
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
