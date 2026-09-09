import type { ToolDefinition } from '../llm/types.js';
import { hasUnfulfilledFileDeliverableGoal } from './document-deliverable.js';
import {
  CompletionConditionLedger,
  type CompletionCondition,
} from './completion-condition.js';
import type { CompletionGateInput } from './completion-gate.js';
import type { HarnessRunState } from './harness-run-state.js';

export interface BuildCompletionContextOptions {
  answerReady: boolean;
  currentTools: readonly ToolDefinition[];
  workspaceRoot?: string;
}

/** 所有 Harness 收尾出口共用的领域无关上下文组装器。 */
export function buildCompletionGateInput(
  state: HarnessRunState,
  options: BuildCompletionContextOptions,
): CompletionGateInput {
  const ledger = new CompletionConditionLedger();
  const canRunTrackedConditions = options.currentTools.some(tool => tool.name === 'run_command');
  for (const condition of state.taskAcceptance?.toCompletionConditions(canRunTrackedConditions) ?? []) {
    ledger.record(condition);
  }

  const task = state.taskState.snapshot();
  if (hasUnfulfilledFileDeliverableGoal(task.goal, task.filesChanged, task.intent)) {
    ledger.record(pendingDeliverableCondition(task.goal));
  }

  return {
    conditions: ledger.list(),
    ledger: state.operationOutcomes,
    answerReady: options.answerReady,
    continuationCount: state.completionGateContinuationCount,
    previousBlockingSignature: state.completionGateBlockingSignature,
  };
}

function pendingDeliverableCondition(goal: string): CompletionCondition {
  return {
    id: `deliverable:${stableTextKey(goal)}`,
    label: 'The explicitly requested deliverable has not been produced.',
    required: true,
    status: 'pending',
    source: 'user',
    sourceRef: goal,
    evidenceRefs: [],
  };
}

function stableTextKey(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
