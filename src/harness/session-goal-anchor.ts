import type { UnifiedMessage } from '../llm/types.js';
import { isSyntheticUserBlockContent } from './compaction-strategy.js';
import { isSystemInjectedUserContent } from './harness-message-utils.js';
import type { HarnessRunState } from './harness-run-state.js';
import {
  isLongRunningImplementationGoal,
  isResumeContinuationMessage,
  resolveEffectiveUserGoal,
} from './resume-goal.js';
import { hasExecutableSideSignal } from './task-state.js';

export const SHORT_GOAL_MAX_LEN = 12;

const PLACEHOLDER_GOALS = new Set([
  '(checkpoint goal unavailable)',
  '(task goal unavailable)',
]);

export function isPoisonedGoal(goal: string): boolean {
  const t = goal.trim();
  if (!t) return true;
  if (PLACEHOLDER_GOALS.has(t)) return true;
  if (t.length <= SHORT_GOAL_MAX_LEN) return true;
  if (isResumeContinuationMessage(t)) return true;
  if (isSyntheticUserBlockContent(t)) return true;
  return false;
}

function isSubstantialGoal(goal: string): boolean {
  const t = goal.trim();
  if (!t || isPoisonedGoal(t)) return false;
  return t.length >= 80
    || hasExecutableSideSignal(t)
    || isLongRunningImplementationGoal(t);
}

function findSubstantialGoalInMessages(messages: readonly UnifiedMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (isSystemInjectedUserContent(msg.content)) continue;
    const t = msg.content.trim();
    if (!t || isResumeContinuationMessage(t)) continue;
    if (isSubstantialGoal(t)) return t;
  }
  return undefined;
}

/**
 * 会话级 immutable goal anchor：checkpoint / TaskState 应优先使用此值，避免短消息污染。
 */
export function resolveSessionGoalAnchor(
  userMessage: string,
  messages: readonly UnifiedMessage[],
  persistedGoal?: string,
): string {
  if (persistedGoal && isSubstantialGoal(persistedGoal)) {
    return persistedGoal.trim();
  }

  const effective = resolveEffectiveUserGoal(userMessage, messages).trim();
  if (isSubstantialGoal(effective)) return effective;

  const fromHistory = findSubstantialGoalInMessages(messages);
  if (fromHistory) return fromHistory;

  if (persistedGoal && !isPoisonedGoal(persistedGoal)) return persistedGoal.trim();
  return effective || persistedGoal?.trim() || '(task goal unavailable)';
}

export function resolveCheckpointUserGoal(
  state: HarnessRunState | undefined,
  fallbackUserMessage: string,
): string {
  if (state?.sessionGoalAnchor && !isPoisonedGoal(state.sessionGoalAnchor)) {
    return state.sessionGoalAnchor.trim();
  }
  const snapGoal = state?.taskState.snapshot().goal;
  if (snapGoal && !isPoisonedGoal(snapGoal)) return snapGoal.trim();
  return fallbackUserMessage.trim() || '(task goal unavailable)';
}
