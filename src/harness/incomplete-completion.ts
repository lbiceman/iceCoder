import type { LLMResponse } from '../llm/types.js';
import type { RepoContextSnapshot, TaskStateSnapshot } from '../types/runtime-snapshot.js';
import type { TaskAcceptanceTracker } from './task-acceptance-tracker.js';
import { hasPendingAcceptanceWork } from './task-acceptance-tracker.js';
import {
  hasUnfulfilledFileDeliverableGoal,
  snapshotHasUnconfirmedFileDeliverables,
  verificationConfirmationStats,
  writeConfirmationPaths,
} from './document-deliverable.js';
import type { TaskState } from './task-state.js';
import type { TaskCheckpoint } from './checkpoint.js';

/** 任务是否仍有未完成的验收工作（Acceptance Gate + file 交付物 + 未写交付物 goal） */
export function hasPendingWork(
  task: TaskStateSnapshot,
  acceptance?: TaskAcceptanceTracker,
): boolean {
  if (hasPendingAcceptanceWork(acceptance)) return true;

  if (hasUnfulfilledFileDeliverableGoal(task.goal, task.filesChanged, task.intent)) {
    return true;
  }

  if (snapshotHasUnconfirmedFileDeliverables(task)) {
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
  const filePaths = writeConfirmationPaths(task.filesChanged);
  const fileStats = verificationConfirmationStats(
    task.filesChanged,
    task.fileDeliverableWriteVersions,
    task.fileDeliverableConfirmVersions,
  );
  const filePending = snapshotHasUnconfirmedFileDeliverables(task);
  if (filePending && fileStats.required > 0) {
    lines.push(
      `- Changed files pending confirmation: ${fileStats.pending} of ${fileStats.required}`
      + (fileStats.exempt > 0 ? ` (${fileStats.exempt} dot-dir/temp exempt)` : ''),
    );
  }
  if (fileStats.required > 0) {
    lines.push(`- Confirm each required path with file_info or read_file (${fileStats.required} file(s)).`);
  } else if (hasUnfulfilledFileDeliverableGoal(task.goal, task.filesChanged, task.intent)) {
    lines.push('- Expected file deliverable has not been written yet.');
  }

  const awaitsFileWrite = hasUnfulfilledFileDeliverableGoal(task.goal, task.filesChanged, task.intent);
  if (filePending && filePaths.length > 0) {
    lines.push(
      '',
      'Continue NOW: run file_info or read_file on each changed file to confirm it exists and is non-empty.',
    );
  } else if (awaitsFileWrite) {
    lines.push(
      '',
      'Continue NOW: write the deliverable with write_file (or edit_file), then run file_info or read_file to confirm it exists and is non-empty.',
      'Do not stop with a chat summary.',
    );
  } else {
    lines.push(
      '',
      'Continue NOW by calling tools (run_command, edit_file, write_file, read_file) as needed.',
      'Do not output plans or thinking-only replies.',
    );
  }

  return lines.join('\n');
}

/** 工具轮结束后，将 Acceptance Gate 进度同步回 TaskState.verificationStatus。 */
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
