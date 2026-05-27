import type { LLMResponse } from '../llm/types.js';
import type { RepoContextSnapshot, TaskStateSnapshot } from '../types/runtime-snapshot.js';
import type { TaskAcceptanceTracker } from './task-acceptance-tracker.js';
import { hasPendingAcceptanceWork } from './task-acceptance-tracker.js';
import type { TaskState } from './task-state.js';
import type { TaskCheckpoint } from './checkpoint.js';

/** 任务是否仍有未完成的工程/验证工作 */
export function hasPendingWork(
  task: TaskStateSnapshot,
  repo: RepoContextSnapshot,
  acceptance?: TaskAcceptanceTracker,
): boolean {
  if (hasPendingAcceptanceWork(acceptance)) return true;

  if (task.verificationStatus === 'failed') return true;

  const verificationAttempted = repo.testCommands.length > 0
    || repo.recentDiagnostics.some(d => /\b(test|vitest|jest|build|lint|typecheck)\b/i.test(d));

  if (task.verificationRequired && task.verificationStatus === 'required' && verificationAttempted) {
    return true;
  }

  if (
    task.filesChanged.length > 0
    && task.verificationStatus !== 'passed'
    && verificationAttempted
    && repo.recentDiagnostics.length > 0
  ) {
    return true;
  }

  return false;
}

export function checkpointHasPendingWork(checkpoint: TaskCheckpoint): boolean {
  return hasPendingWork(checkpoint.taskState, checkpoint.repoContext);
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
  if (task.verificationStatus === 'failed' || task.verificationStatus === 'required') {
    lines.push(`- Verification status: ${task.verificationStatus}`);
  }
  const lastTest = repo.testCommands.at(-1);
  if (lastTest) {
    lines.push(`- Last verification command: ${lastTest}`);
  }
  if (task.filesChanged.length > 0) {
    lines.push(`- Changed files (${task.filesChanged.length}): continue from these and re-run verification.`);
  }

  lines.push(
    '',
    'Continue NOW by calling tools (run_command, edit_file, write_file, read_file).',
    'Do not output plans or thinking-only replies. Run tests, fix failures, then proceed.',
  );

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
