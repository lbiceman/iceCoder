import type { LLMResponse, ToolDefinition } from '../llm/types.js';
import type { CheckpointDeps } from './harness-checkpoint.js';
import { recordTelemetrySummary, saveTaskCheckpoint } from './harness-checkpoint.js';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  MAX_CONSECUTIVE_TOOL_FAILURES,
} from './harness-constants.js';
import type { ResilienceBridgeDeps } from './harness-resilience.js';
import {
  resilienceMaybeBranchRecover,
  resilienceMaybeReviewStep,
  resilienceRecordToolCalls,
  resilienceSaveCheckpoint,
} from './harness-resilience.js';
import { collectRepeatedFailures, toolCallSignature } from './harness-permission-runtime.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { StopHandlerDeps } from './harness-stop-handler.js';
import { handleHarnessStop } from './harness-stop-handler.js';
import type { ToolExecutorDeps } from './harness-tool-executor.js';
import { executeToolCallsStreaming } from './harness-tool-executor.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type { GraphExecutor } from './task-graph-executor.js';
import type { HarnessMemoryIntegration } from './harness-memory.js';
import type { ExecutionModeConfig } from '../types/supervisor.js';
import type { TaskGraphSnapshot } from '../types/task-graph.js';
import {
  recordTaskBearingRoundIfForced,
  syncExecutionModeLoopState,
} from './supervisor/execution-mode-constraints.js';
import type {
  ChatFunction,
  HarnessResult,
  HarnessStepEvent,
  StreamFunction,
} from './types.js';

export interface ToolRoundDeps extends ToolExecutorDeps, CheckpointDeps, ResilienceBridgeDeps, StopHandlerDeps {
  loopController: LoopController;
  memoryIntegration: HarnessMemoryIntegration;
  graphExecutor: GraphExecutor;
  executionModeConfig?: ExecutionModeConfig;
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
    content: response.content || undefined,
    tokenUsage: { inputTokens: tokenUsage.input, outputTokens: tokenUsage.output },
    totalTokenUsage: {
      inputTokens: deps.loopController.getState().lastInputTokens,
      outputTokens: deps.loopController.getState().lastOutputTokens,
    },
  });

  msgs.push({
    role: 'assistant',
    content: response.content || '',
    toolCalls: response.toolCalls,
    reasoningContent: response.reasoningContent,
  });

  state.branchBudgetWarnedThisRound = false;
  state.stepReviewedThisRound = false;

  const blockedToolSignatures = new Set<string>();
  const graphSnapshotBefore = deps.graphExecutor?.toSnapshot();

  if (deps.graphExecutor?.hasGraph() && response.toolCalls) {
    for (const tc of response.toolCalls) {
      const check = deps.graphExecutor.checkToolCall(tc.name);
      if (check.action === 'block' && check.message) {
        blockedToolSignatures.add(toolCallSignature(tc));
        msgs.push({ role: 'user', content: check.message });
      } else if (check.action === 'warn' && check.message) {
        msgs.push({ role: 'user', content: check.message });
      }
    }
  }

  const repoFilesChangedBefore = state.repoContext.snapshot().filesChanged.length;
  const toolStats = await executeToolCallsStreaming(deps, {
    toolCalls: response.toolCalls!,
    messages: msgs,
    logger,
    onStep,
    harnessAbortSignal: deps.abortSignal,
    taskState: state.taskState,
    repoContext: state.repoContext,
    chatFn,
    currentTools,
  });
  const failedSignaturesForSignals = new Set(toolStats.failedSignatures);
  if (deps.executionModeConfig && toolStats.failedCount > 0) {
    state.submitModeSignal?.('step_gate', 'tool_failure', { failedCount: toolStats.failedCount });
  }
  if (deps.executionModeConfig) {
    const writeTargetsThisRound = countWriteTargets(response.toolCalls!, failedSignaturesForSignals);
    if (writeTargetsThisRound > deps.executionModeConfig.writeTargetsEnterThreshold) {
      state.submitModeSignal?.('step_gate', 'multi_write', { writeTargetsThisRound });
    }
  }

  await resilienceRecordToolCalls(
    deps,
    response.toolCalls!,
    new Set(toolStats.failedSignatures),
    state,
  );

  const repeatedFailures = collectRepeatedFailures(
    response.toolCalls!,
    toolStats.failedSignatures,
    state.failedToolCallSignatures,
  );
  if (repeatedFailures.length > 0) {
    msgs.push({
      role: 'user',
      content: `[System] Repeated failed tool call detected: ${repeatedFailures.join(', ')}. Do not retry the same tool with the same arguments. Change the path, parameters, command, or use a different tool; if blocked, explain the exact blocker and evidence.`,
    });
  }

  resilienceMaybeBranchRecover(deps, state, msgs);

  if (toolStats.failedCount > 0) {
    await resilienceMaybeReviewStep(deps, state, 'tool_failure', chatFn);
  }

  if (state.taskState.snapshot().verificationStatus === 'failed') {
    await resilienceSaveCheckpoint(deps, 'verification_failed', state);
    if (!state.stepReviewedThisRound) {
      await resilienceMaybeReviewStep(deps, state, 'verification_failure', chatFn);
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

  if (toolStats.totalCount > 0 && toolStats.failedCount === toolStats.totalCount) {
    state.consecutiveToolFailures++;
    const failureCount = state.consecutiveToolFailures;

    if (failureCount >= CIRCUIT_BREAKER_THRESHOLD) {
      console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，触发熔断`);
      deps.loopController.stop('circuit_breaker');
      const finalState = deps.loopController.getState();
      logger.loopStop('circuit_breaker', finalState.currentRound, finalState.totalToolCalls);
      await saveTaskCheckpoint(deps, 'failed', userMessage, msgs, state, 'circuit_breaker');
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

    if (failureCount >= 6) {
      msgs.push({
        role: 'user',
        content: `[System] Warning: ${failureCount} consecutive rounds of tool calls have all failed. Multiple attempts have not succeeded.\n\nYou must:\n1. Stop retrying the same failed tool calls, commands, paths, or parameters\n2. Switch strategy: use a different tool, inspect paths/configuration, simplify the command, or ask for missing input\n3. If blocked, explain the exact blocker and evidence to the user\n\nYou may still use tools, but only with a changed strategy. Do not repeat an identical failed operation.`,
      });
      console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，注入换策略提示`);
    } else if (failureCount >= MAX_CONSECUTIVE_TOOL_FAILURES) {
      const lastErrors = msgs
        .slice(-6)
        .filter(m => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('Tool execution error:'))
        .map(m => (m.content as string).substring(0, 200));

      const errorSummary = lastErrors.length > 0
        ? `Recent errors:\n${lastErrors.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
        : '';

      msgs.push({
        role: 'user',
        content: `[System] Note: ${failureCount} consecutive rounds of tool calls have all failed.${errorSummary ? '\n' + errorSummary : ''}\n\nPlease analyze the failure reasons and adopt a completely different approach to complete the task. Possible adjustment directions:\n- Check if file paths are correct (use list_directory to confirm)\n- Check if command syntax is correct\n- Try using alternative tools\n- If execution is truly impossible, directly explain the reason to the user and do not continue trying the same operation.`,
      });
      console.log(`[harness] 连续 ${failureCount} 轮工具全部失败，注入策略调整提示`);
    } else if (failureCount === 2) {
      msgs.push({
        role: 'user',
        content: '[System] All tool calls in the previous round failed. Please check if parameters are correct and try adjusting your approach.',
      });
    }
  } else {
    state.consecutiveToolFailures = 0;
  }

  if (deps.graphExecutor?.hasGraph() && response.toolCalls) {
    for (const tc of response.toolCalls) {
      const sig = toolCallSignature(tc);
      const success = !toolStats.failedSignatures.includes(sig);
      deps.graphExecutor.recordToolResult(tc.name, success);
    }
    const evalResult = deps.graphExecutor.evaluateRound(response.toolCalls.length);
    if (evalResult.action === 'force_switch') {
      onStep?.({ type: 'task_graph_branch', reason: 'fallback_activated', message: evalResult.message });
      if (evalResult.message) {
        msgs.push({ role: 'user', content: evalResult.message });
      }
    } else if (evalResult.message) {
      msgs.push({ role: 'user', content: evalResult.message });
    }
  }
  const graphSnapshotAfter = deps.graphExecutor?.toSnapshot();

  if (deps.executionModeConfig) {
    const failedSignatures = new Set(toolStats.failedSignatures);
    const successfulExecutableCalls = response.toolCalls?.filter(tc => {
      const sig = toolCallSignature(tc);
      return !failedSignatures.has(sig) && !blockedToolSignatures.has(sig);
    }) ?? [];
    const hadSuccessfulToolExecute = toolStats.totalCount > toolStats.failedCount
      && successfulExecutableCalls.length > 0;
    const writeToolSucceeded = (response.toolCalls?.some(tc => (
      TASK_BEARING_WRITE_TOOLS.has(tc.name)
        && !failedSignatures.has(toolCallSignature(tc))
        && !blockedToolSignatures.has(toolCallSignature(tc))
    )) ?? false) && toolStats.totalCount > toolStats.failedCount;
    const repoFilesChangedAfter = state.repoContext.snapshot().filesChanged.length;
    recordTaskBearingRoundIfForced(state, {
      hadSuccessfulToolExecute,
      graphStepAdvanced: didGraphStepAdvance(graphSnapshotBefore, graphSnapshotAfter),
      writeToolSucceededWithFileChange: writeToolSucceeded && repoFilesChangedAfter > repoFilesChangedBefore,
    }, deps.executionModeConfig);
    syncExecutionModeLoopState(deps.loopController, state);
  }

  await saveTaskCheckpoint(deps, 'running', userMessage, msgs, state);
  await resilienceSaveCheckpoint(deps, 'step_completed', state);

  const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'append_file', 'patch_file', 'run_command']);
  const hadWriteTool = response.toolCalls?.some(tc => WRITE_TOOLS.has(tc.name)) ?? false;
  if (hadWriteTool) {
    state.consecutiveReadOnlyRounds = 0;
  } else if (response.toolCalls?.length) {
    state.consecutiveReadOnlyRounds++;
    if (state.consecutiveReadOnlyRounds === 5) {
      msgs.push({
        role: 'user',
        content: '[System] You have been reading/analyzing for 5 rounds without making any edits. If you have enough context, start implementing changes now using write/edit tools. Do not read more files unless absolutely necessary.',
      });
    }
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
