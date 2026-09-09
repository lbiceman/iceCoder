import { buildTotalTokenUsageWithContext } from './context-usage-display.js';
import type { ToolDefinition, UnifiedMessage } from '../llm/types.js';
import type { CheckpointDeps } from './harness-checkpoint.js';
import { recordTelemetrySummary, saveTaskCheckpoint } from './harness-checkpoint.js';
import { resolveCheckpointUserGoal } from './session-goal-anchor.js';
import type { ResilienceBridgeDeps } from './harness-resilience.js';
import { resilienceSaveCheckpoint } from './harness-resilience.js';
import type { HarnessRunState } from './harness-run-state.js';
import type { HarnessLogger } from './logger.js';
import type { LoopController } from './loop-controller.js';
import type { GraphExecutor } from './task-graph-executor.js';
import { sanitizeAssistantContentForUser } from './text-tool-call-salvage.js';
import type { HarnessResult, HarnessStepEvent } from './types.js';
import { CompletionGate } from './completion-gate.js';
import { buildCompletionGateInput } from './completion-context.js';

export interface GraphStopDeps extends CheckpointDeps, ResilienceBridgeDeps {
  loopController: LoopController;
  workspaceRoot?: string;
}

/** 图 terminal 与普通无工具收尾共用同一个 CompletionGate。 */
export function shouldBlockGraphTerminalStop(
  state: HarnessRunState,
  workspaceRoot?: string,
): boolean {
  const completion = new CompletionGate().evaluate(buildCompletionGateInput(state, {
    answerReady: true,
    currentTools: state.tools,
    workspaceRoot,
  }));
  return completion.action !== 'complete';
}

export interface TryGraphTerminalStopArgs {
  state: HarnessRunState;
  graphExecutor: GraphExecutor;
  userMessage: string;
  currentTools: ToolDefinition[];
  logger: HarnessLogger;
  onStep?: (event: HarnessStepEvent) => void;
}

/**
 * 任务图已 terminal 且统一收尾门控允许完成时，以 model_done 结束。
 */
export async function tryGraphTerminalStop(
  deps: GraphStopDeps,
  args: TryGraphTerminalStopArgs,
): Promise<HarnessResult | null> {
  const { state, graphExecutor, userMessage, currentTools, logger, onStep } = args;
  if (!graphExecutor.isGraphDoneForHarnessStop()) {
    return null;
  }

  if (shouldBlockGraphTerminalStop(state, deps.workspaceRoot)) {
    return null;
  }
  const completion = new CompletionGate().evaluate(buildCompletionGateInput(state, {
    answerReady: true,
    currentTools,
    workspaceRoot: deps.workspaceRoot,
  }));

  onStep?.({ type: 'task_graph_done' });

  deps.loopController.stop('model_done');
  const finalState = deps.loopController.getState();
  logger.loopStop('model_done', finalState.currentRound, finalState.totalToolCalls);

  const msgs = state.messages;
  await saveTaskCheckpoint(
    deps,
    'completed',
    resolveCheckpointUserGoal(state, userMessage),
    msgs,
    state,
    'model_done',
  );
  await resilienceSaveCheckpoint(deps, 'final_draft', state, 'model_done');
  recordTelemetrySummary(deps, 'model_done', state, {
    status: completion.status,
    reason: completion.reason,
  });

  const finalContent = resolveGraphDoneFinalContent(msgs);

  onStep?.({
    type: 'final',
    iteration: finalState.currentRound,
    totalToolCalls: finalState.totalToolCalls,
    content: finalContent,
    stopReason: 'model_done',
    completionStatus: completion.status,
    completionReason: completion.reason,
    totalTokenUsage: buildTotalTokenUsageWithContext(msgs, currentTools, {
      lastInputTokens: finalState.lastInputTokens,
      lastOutputTokens: finalState.lastOutputTokens,
    }),
  });

  console.log('[harness] 任务图已 terminal 且无 pending 验收工作，强制 model_done 停止');

  return {
    content: finalContent,
    loopState: finalState,
    messages: [...msgs],
    log: logger.getEntries(),
    completionStatus: completion.status,
  };
}

function resolveGraphDoneFinalContent(msgs: UnifiedMessage[]): string {
  const lastAssistant = [...msgs].reverse().find(
    m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim(),
  );
  if (lastAssistant && typeof lastAssistant.content === 'string') {
    return sanitizeAssistantContentForUser(lastAssistant.content);
  }
  return '任务图步骤已全部完成。';
}
