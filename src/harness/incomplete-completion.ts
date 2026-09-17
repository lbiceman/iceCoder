import type { LLMResponse } from '../llm/types.js';
import type { RepoContextSnapshot, TaskStateSnapshot } from '../types/runtime-snapshot.js';
import type { ProjectCheckpointV3 } from '../types/runtime-checkpoint.js';
import {
  hasUnfulfilledFileDeliverableGoal,
} from './document-deliverable.js';

/** 是否仍有明确文件交付目标未完成。验收计划不在这里硬拦。 */
export function hasPendingWork(
  task: TaskStateSnapshot,
  _workspaceRoot?: string,
): boolean {
  return hasUnfulfilledFileDeliverableGoal(task.goal, task.filesChanged, task.intent);
}

export function checkpointHasPendingWork(checkpoint: ProjectCheckpointV3): boolean {
  if (
    checkpoint.completion.status === 'completed'
    || checkpoint.completion.status === 'completed_unverified'
  ) {
    return false;
  }
  const completedOutcomeIds = new Set(
    checkpoint.completion.operationOutcomes
      .filter(outcome => outcome.status === 'completed')
      .map(outcome => outcome.toolCallId),
  );
  const hasRequiredBlocker = checkpoint.completion.conditions.some(condition =>
    condition.required
    && (
      condition.status !== 'satisfied'
      || condition.evidenceRefs.length === 0
      || !condition.evidenceRefs.some(ref => completedOutcomeIds.has(ref))
    ),
  );
  return hasRequiredBlocker || hasUnfulfilledFileDeliverableGoal(
    checkpoint.execution.taskState.goal,
    checkpoint.execution.taskState.filesChanged,
    checkpoint.execution.taskState.intent,
  );
}

/** 仅 reasoning、无可见 content、无 toolCalls */
export function isReasoningOnlyResponse(response: LLMResponse): boolean {
  if (response.toolCalls?.length) return false;
  const contentEmpty = !response.content?.trim();
  const hasReasoning = !!response.reasoningContent?.trim();
  return contentEmpty && hasReasoning;
}

export function buildIncompleteContinuationPrompt(
  task: TaskStateSnapshot,
  repo: RepoContextSnapshot,
  _workspaceRoot?: string,
): string {
  const lines = [
    '[System] The task is NOT complete. Do not stop without calling tools.',
    '',
    'Evidence:',
  ];

  if (repo.recentDiagnostics.length > 0) {
    lines.push(`- Recent tool failures: ${repo.recentDiagnostics.slice(-3).join('; ')}`);
  }

  const awaitsFileWrite = hasUnfulfilledFileDeliverableGoal(task.goal, task.filesChanged, task.intent);
  if (awaitsFileWrite) {
    lines.push('- An explicitly requested result has not been produced.');
  }

  if (awaitsFileWrite) {
    lines.push(
      '',
      'Continue now and produce the requested result with available tools.',
      'Do not stop with a chat summary.',
    );
  } else {
    lines.push(
      '',
      'Continue now with the available tools as needed.',
      'Do not output plans or thinking-only replies.',
    );
  }

  return lines.join('\n');
}
