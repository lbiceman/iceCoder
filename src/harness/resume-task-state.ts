import type { UnifiedMessage } from '../llm/types.js';
import type { RepoContext } from './repo-context.js';
import type { TaskState } from './task-state.js';
import { inferIntent } from './task-state.js';
import { isResumeContinuationMessage } from './resume-goal.js';
import { isPoisonedGoal, resolveSessionGoalAnchor } from './session-goal-anchor.js';
import { bigramJaccard } from './harness-message-utils.js';
import { shouldApplyCasualHarness } from './casual-mode.js';
import {
  areAllVerificationExemptPaths,
  hasEngineeringTestTargets,
} from './document-deliverable.js';

/** Harness 软失败：不应在下一轮 hydrate 时触发 verification failed */
export function isSoftHarnessDiagnostic(diag: string): boolean {
  const d = diag.trim();
  if (!d) return true;
  if (/read-before-edit:/i.test(d)) return true;
  if (/remember_required:/i.test(d)) return true;
  if (/no match found for search string/i.test(d)) return true;
  if (/\benoent\b|no such file or directory|file not found/i.test(d)) {
    if (/memory-files|user-memory|session-notes/i.test(d)) return true;
  }
  return false;
}

function shouldForceVerificationFailedAfterHydrate(
  diagnostics: readonly string[],
  filesChanged: readonly string[],
): boolean {
  if (diagnostics.length === 0) return false;
  if (diagnostics.every(isSoftHarnessDiagnostic)) return false;
  if (!hasEngineeringTestTargets(filesChanged)) return false;
  return true;
}

function clearVerificationForExemptOnlyWork(taskState: TaskState): void {
  const snap = taskState.snapshot();
  if (!areAllVerificationExemptPaths(snap.filesChanged)) return;
  taskState.applySnapshot({
    ...snap,
    verificationRequired: false,
    verificationStatus: 'not_required',
    phase: snap.phase === 'verification' ? 'editing' : snap.phase,
  });
}

/**
 * 当前用户消息是否是「与旧任务无关的新查询」。
 *
 * 触发条件（同时满足）：
 *   - 不是续聊（`继续` / `resume` 等）；
 *   - 当前消息按 `inferIntent` 判定为 casual（question / inspect）；
 *   - 与旧 goal 的 bigram Jaccard 相似度 < 0.18（主题切换）。
 *
 * 命中后，hydrate 不再继承旧 goal 的 `filesChanged` / `verificationStatus`，
 * 避免新查询被旧的 verification gate 拉回 LLM 循环。
 */
export function isFreshQueryMessage(userMessage: string, oldGoal: string): boolean {
  const t = userMessage.trim();
  if (!t) return false;
  if (isResumeContinuationMessage(t)) return false;

  const oldGoalTrim = (oldGoal ?? '').trim();
  if (!oldGoalTrim || isPoisonedGoal(oldGoalTrim)) {
    return shouldApplyCasualHarness(inferIntent(t));
  }

  const intent = inferIntent(t);
  if (!shouldApplyCasualHarness(intent)) return false;

  const similarity = bigramJaccard(t.toLowerCase(), oldGoalTrim.toLowerCase());
  return similarity < 0.18;
}

/**
 * session-notes 恢复后对齐 TaskState：修正「继续」污染、合并 Repo 证据、强制失败态。
 *
 * 「新查询」分支（{@link isFreshQueryMessage}）：rebind 到当前消息、清掉旧 filesChanged /
 * verificationStatus / diagnostics，避免旧 edit 任务的 verification gate 把无关的问答轮拉回循环。
 *
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

  if (isFreshQueryMessage(userMessage, snap.goal)) {
    // 新查询：与旧任务隔离，避免 verification gate 误判
    const freshGoal = userMessage.trim();
    taskState.rebindGoal(freshGoal);
    taskState.applySnapshot({
      ...taskState.snapshot(),
      goal: freshGoal,
      intent: inferIntent(freshGoal),
      filesRead: [],
      filesChanged: [],
      commandsRun: [],
      verificationRequired: false,
      verificationStatus: 'not_required',
    });
    return isPoisonedGoal(anchor) ? freshGoal : anchor;
  }

  if (isResumeContinuationMessage(userMessage)) {
    if (!isPoisonedGoal(anchor)) {
      taskState.rebindGoal(anchor);
    }
  } else {
    const trimmed = userMessage.trim();
    if (trimmed && !isPoisonedGoal(trimmed)) {
      taskState.rebindGoal(trimmed);
    } else if (isPoisonedGoal(snap.goal) && !isPoisonedGoal(anchor)) {
      taskState.rebindGoal(anchor);
    }
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
  taskState.reconcileOrphanFileDeliverableWriteVersions();
  clearVerificationForExemptOnlyWork(taskState);

  if (shouldForceVerificationFailedAfterHydrate(repo.recentDiagnostics, mergedFilesChanged)) {
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
