import type { UnifiedMessage } from '../llm/types.js';
import type { RepoContext } from './repo-context.js';
import type { TaskState } from './task-state.js';
import { inferIntent } from './task-state.js';
import { isResumeContinuationMessage } from './resume-goal.js';
import { isPoisonedGoal, resolveSessionGoalAnchor } from './session-goal-anchor.js';

/**
 * session-notes 恢复后对齐 TaskState：修正「继续」污染、合并 Repo 证据、强制失败态。
 * @returns 解析后的 session goal anchor（可能与入参不同，例如入参已污染时回退到历史 substantial goal）
 */
export function syncHydratedTaskState(
  userMessage: string,
  messages: readonly UnifiedMessage[],
  taskState: TaskState,
  repoContext: RepoContext,
  sessionGoalAnchor?: string,
): string {
  const anchor = sessionGoalAnchor && !isPoisonedGoal(sessionGoalAnchor)
    ? sessionGoalAnchor
    : resolveSessionGoalAnchor(userMessage, messages, sessionGoalAnchor);
  const snap = taskState.snapshot();
  const repo = repoContext.snapshot();

  const shouldRebindGoal = isResumeContinuationMessage(userMessage)
    || isPoisonedGoal(snap.goal);

  if (shouldRebindGoal && !isPoisonedGoal(anchor)) {
    taskState.rebindGoal(anchor);
  }

  const mergedFilesRead = [...new Set([...taskState.snapshot().filesRead, ...repo.filesRead])];
  const mergedFilesChanged = [...new Set([...taskState.snapshot().filesChanged, ...repo.filesChanged])];
  const mergedCommands = [...new Set([...taskState.snapshot().commandsRun, ...repo.commandsRun])];

  taskState.applySnapshot({
    ...taskState.snapshot(),
    goal: taskState.snapshot().goal,
    intent: inferIntent(taskState.snapshot().goal),
    filesRead: mergedFilesRead,
    filesChanged: mergedFilesChanged,
    commandsRun: mergedCommands,
  });

  if (repo.recentDiagnostics.length > 0) {
    taskState.forceVerificationFailed();
  }

  return anchor;
}

/** @deprecated use syncHydratedTaskState */
export function applyResumeTaskStateFixups(
  userMessage: string,
  messages: readonly UnifiedMessage[],
  taskState: TaskState,
  repoContext: RepoContext,
): void {
  syncHydratedTaskState(userMessage, messages, taskState, repoContext);
}
