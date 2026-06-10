import type { LLMResponse } from '../llm/types.js';
import type { RepoContextSnapshot, TaskStateSnapshot } from '../types/runtime-snapshot.js';
import type { TaskAcceptanceTracker } from './task-acceptance-tracker.js';
import { hasPendingAcceptanceWork } from './task-acceptance-tracker.js';
import {
  engineeringTestTargetPaths,
  hasUnfulfilledFileDeliverableGoal,
  shouldPromptEngineeringUnitTest,
} from './document-deliverable.js';
import type { TaskState } from './task-state.js';
import type { TaskCheckpoint } from './checkpoint.js';

/** 任务是否仍有未完成的验收工作（Acceptance Gate + 未写交付物 goal） */
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
  if (task.verificationStatus === 'failed') {
    lines.push('- Unit tests failed; fix and re-run before stopping.');
  } else if (shouldPromptEngineeringUnitTest(task.filesChanged, task.verificationStatus)) {
    lines.push('- Source code changed but unit tests have not passed yet.');
  }

  const awaitsFileWrite = hasUnfulfilledFileDeliverableGoal(task.goal, task.filesChanged, task.intent);
  if (awaitsFileWrite) {
    lines.push('- Expected file deliverable has not been written yet.');
  }

  const testTargets = engineeringTestTargetPaths(task.filesChanged);
  if (testTargets.length > 0 && task.verificationStatus !== 'passed') {
    const maxList = 12;
    const listed = testTargets.slice(0, maxList);
    lines.push('', 'Changed source files (run unit tests covering these):');
    for (const p of listed) {
      lines.push(`- ${p}`);
    }
    if (testTargets.length > maxList) {
      lines.push(`- … and ${testTargets.length - maxList} more`);
    }
  }

  if (awaitsFileWrite) {
    lines.push(
      '',
      'Continue NOW: write the deliverable with write_file (or edit_file).',
      'Do not stop with a chat summary.',
    );
  } else if (task.verificationStatus === 'failed') {
    lines.push(
      '',
      'Continue NOW: fix failing tests, then re-run unit tests via run_command until green.',
      'Do not output plans or thinking-only replies.',
    );
  } else if (shouldPromptEngineeringUnitTest(task.filesChanged, task.verificationStatus)) {
    lines.push(
      '',
      'Continue NOW: run unit tests for the changed source files via run_command (choose the command for this project).',
      'Do not output plans or thinking-only replies.',
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
