import type { UnifiedMessage } from '../llm/types.js';
import { normalizeMessages } from './context-assembler.js';
import { shouldApplyCasualHarness } from './casual-mode.js';
import type { CompactionDeps } from './harness-compaction.js';
import { maybeCompact } from './harness-compaction.js';
import {
  applySubAgentResultRetention,
  applyToolResultBudget,
} from './harness-message-budget.js';
import {
  bigramJaccard,
  getLastAssistantText,
  getLatestRealUserText,
  isActionableToolRequest,
} from './harness-message-utils.js';
import { TASK_SWITCH_JACCARD_THRESHOLD } from './harness-constants.js';
import { upsertRuntimeContextMessage } from './harness-runtime-inject.js';
import type { StopHandlerDeps } from './harness-stop-handler.js';
import { handleHarnessStop } from './harness-stop-handler.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { HarnessMemoryIntegration } from './harness-memory.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type { GraphExecutor } from './task-graph-executor.js';
import { shouldUseTaskGraph } from './task-graph-config.js';
import { buildToolPlan, formatToolPlan } from './tool-planner.js';
import type { RuntimeTelemetry } from './runtime-telemetry.js';
import {
  markForcedDegraded,
  syncExecutionModeLoopState,
} from './supervisor/execution-mode-constraints.js';
import type {
  ChatFunction,
  HarnessResult,
  HarnessStepEvent,
  StreamFunction,
} from './types.js';
export interface RoundPrepDeps extends CompactionDeps, StopHandlerDeps {
  loopController: LoopController;
  memoryIntegration: HarnessMemoryIntegration;
  graphExecutor: GraphExecutor;
  runtimeTelemetry?: RuntimeTelemetry;
}

export interface PrepareHarnessRoundArgs {
  state: HarnessRunState;
  userMessage: string;
  chatFn: ChatFunction;
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
  streamFn?: StreamFunction;
}

export type PrepareHarnessRoundResult =
  | { action: 'continue'; normalizedMsgs: UnifiedMessage[]; round: number }
  | { action: 'stop'; result: HarnessResult };

/**
 * 轮次预处理：压缩、推进轮次、运行时注入、任务图、记忆、工具规划、规范化与预算、任务切换检测。
 */
export async function prepareHarnessRound(
  deps: RoundPrepDeps,
  args: PrepareHarnessRoundArgs,
): Promise<PrepareHarnessRoundResult> {
  const { state, userMessage, chatFn, logger, onStep, streamFn } = args;
  const { messages: msgs, tools: currentTools } = state;

  await maybeCompact(deps, { messages: msgs, chatFn, logger, onStep, state });

  deps.loopController.advanceRound();
  state.turnCount++;
  // W1: 在轮次开始时锚定 filesChanged 基线 + 重置本轮 branchSwitched 标记，
  // 供 evaluateExecutionModeBeforeLlm 派生 accumulatedDiffLines / branchSwitchedThisRound。
  state.filesChangedAtRoundStart = state.repoContext.snapshot().filesChanged.length;
  state.branchSwitchedThisRound = false;
  const round = deps.loopController.getState().currentRound;
  logger.roundStart(round, msgs.length);
  deps.runtimeTelemetry?.recordRound({
    round,
    task: state.taskState.snapshot(),
    repo: state.repoContext.snapshot(),
  });

  const loopStop = deps.loopController.shouldContinue();
  if (loopStop) {
    return {
      action: 'stop',
      result: await handleHarnessStop(deps, {
        reason: loopStop,
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

  logger.llmCall();

  upsertRuntimeContextMessage(msgs, state);

  if (state.turnCount === 1 && deps.graphExecutor) {
    const taskSnapshot = state.taskState.snapshot();
    if (shouldUseTaskGraph(taskSnapshot.intent)) {
      try {
        deps.graphExecutor.initGraph({
          goal: taskSnapshot.goal || userMessage,
          intent: taskSnapshot.intent,
        });
        onStep?.({
          type: 'task_graph_init',
          graphGoal: taskSnapshot.goal || userMessage,
          graphIntent: taskSnapshot.intent,
          plan: deps.graphExecutor.toView() ?? undefined,
        });
      } catch (err) {
        if (!markForcedDegraded(state, 'graph')) {
          throw err;
        }
        state.submitModeSignal?.('graph_executor', 'recovery_pending', {
          reason: 'task_graph_init_failed',
          message: err instanceof Error ? err.message : String(err),
        });
        syncExecutionModeLoopState(deps.loopController, state);
      }
    }
  }

  if (deps.graphExecutor?.hasGraph()) {
    const ctx = deps.graphExecutor.getCurrentNodeContext();
    if (ctx) {
      msgs.push({ role: 'user', content: ctx });
    }
    const snap = deps.graphExecutor.toSnapshot();
    if (snap?.cursor) {
      onStep?.({ type: 'task_graph_node', nodeId: snap.cursor.nodeId, nodeIndex: snap.cursor.nodeIndex, graphStatus: snap.status });
    }
  }

  {
    const intent = state.taskState.snapshot().intent;
    const memoryMode = shouldApplyCasualHarness(intent) ? 'casual_light' as const : 'coarse_pre_llm' as const;
    await deps.memoryIntegration.injectMemoryContext(msgs, { mode: memoryMode, onStep });
  }

  if (
    state.turnCount === 1
    && currentTools.length > 0
    && isActionableToolRequest(getLatestRealUserText(msgs, userMessage))
    && !shouldApplyCasualHarness(state.taskState.snapshot().intent)
  ) {
    msgs.push({
      role: 'user',
      content: formatToolPlan(
        buildToolPlan(getLatestRealUserText(msgs, userMessage), state.taskState.snapshot()),
      ),
    });

    // 首轮可执行：若检测到下面对话块会判定「与上一轮 assistant 无关」则延后初始化计划，
    // 避免任务切换分支重复推送 plan 事件（maybeInitExecutionPlan removed Phase 11）。
  }

  const normalizedMsgs = normalizeMessages(msgs);
  applySubAgentResultRetention(normalizedMsgs);
  applyToolResultBudget(normalizedMsgs);

  if (!state.taskSwitchInjected) {
    const latestUserContent = getLatestRealUserText(msgs, userMessage);
    const lastAssistantText = getLastAssistantText(msgs);
    if (latestUserContent && lastAssistantText) {
      const similarity = bigramJaccard(latestUserContent, lastAssistantText);
      if (similarity < TASK_SWITCH_JACCARD_THRESHOLD) {
        msgs.push({
          role: 'user',
          content: '[System: You have received a new task request that appears unrelated to the current pending work. Completely pause any previous task and focus only on the new instruction. Do not resume previous actions unless explicitly asked.]',
        });
        state.taskSwitchInjected = true;
      }
    }
  }

  if (deps.loopController.isAborted()) {
    return {
      action: 'stop',
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

  return { action: 'continue', normalizedMsgs, round };
}
