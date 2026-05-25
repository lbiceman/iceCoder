import type { UnifiedMessage } from '../llm/types.js';
import type { RepoContext } from './repo-context.js';
import type { TaskState } from './task-state.js';
import { inferIntent } from './task-state.js';
import {
  isResumeContinuationMessage,
  resolveEffectiveUserGoal,
} from './resume-goal.js';

const SHORT_GOAL_MAX_LEN = 12;

function isPoisonedHydratedGoal(goal: string): boolean {
  const t = goal.trim();
  return t.length <= SHORT_GOAL_MAX_LEN || isResumeContinuationMessage(t);
}

/**
 * session-notes 恢复后对齐 TaskState：修正「继续」污染、合并 Repo 证据、强制失败态。
 */
export function syncHydratedTaskState(
  userMessage: string,
  messages: readonly UnifiedMessage[],
  taskState: TaskState,
  repoContext: RepoContext,
): void {
  const effectiveGoal = resolveEffectiveUserGoal(userMessage, messages);
  const snap = taskState.snapshot();
  const repo = repoContext.snapshot();

  const shouldRebindGoal = isResumeContinuationMessage(userMessage)
    || (isPoisonedHydratedGoal(snap.goal) && effectiveGoal.trim().length > snap.goal.trim().length);

  if (shouldRebindGoal) {
    taskState.rebindGoal(effectiveGoal);
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
