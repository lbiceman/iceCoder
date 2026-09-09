import type { LLMResponse } from '../llm/types.js';
import type { RepoContextSnapshot, TaskStateSnapshot } from '../types/runtime-snapshot.js';
import type { TaskAcceptanceTracker } from './task-acceptance-tracker.js';
import { hasPendingAcceptanceWork } from './task-acceptance-tracker.js';
import {
  hasUnfulfilledFileDeliverableGoal,
} from './document-deliverable.js';
import type { TaskState } from './task-state.js';
import type { TaskCheckpoint } from './checkpoint.js';

/** 兼容事实查询：是否仍有显式条件或交付目标未完成。 */
export function hasPendingWork(
  task: TaskStateSnapshot,
  acceptance?: TaskAcceptanceTracker,
  workspaceRoot?: string,
): boolean {
  if (hasPendingAcceptanceWork(acceptance)) return true;

  if (hasUnfulfilledFileDeliverableGoal(task.goal, task.filesChanged, task.intent)) {
    return true;
  }

  return false;
}

export function checkpointHasPendingWork(checkpoint: TaskCheckpoint): boolean {
  return hasPendingWork(checkpoint.taskState);
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
  acceptance?: TaskAcceptanceTracker,
  workspaceRoot?: string,
): string {
  if (hasPendingAcceptanceWork(acceptance) && acceptance) {
    return acceptance.buildAcceptancePrompt();
  }

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

/** 工具轮结束后，将兼容验收适配器进度同步到旧验证状态。 */
export function syncTaskVerificationFromAcceptance(
  taskState: TaskState,
  acceptance: TaskAcceptanceTracker | undefined,
): void {
  if (!acceptance?.isActive()) return;
  if (acceptance.isComplete()) {
    taskState.markVerificationPassed();
  } else if (acceptance.hasFailure()) {
    taskState.forceVerificationFailed();
  } else {
    taskState.markVerificationRequired();
  }
}
