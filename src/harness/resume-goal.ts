import type { UnifiedMessage } from '../llm/types.js';
import { isSystemInjectedUserContent } from './harness-message-utils.js';
import { hasExecutableSideSignal, inferIntent } from './task-state.js';

/** 用户口头续跑（非新任务描述） */
const RESUME_CONTINUATION = /^(继续|接着|接着做|往下做|继续吧|继续执行|continue|resume|go on|keep going|carry on)[\s.!。！？]*$/i;

export function isResumeContinuationMessage(text: string): boolean {
  return RESUME_CONTINUATION.test(text.trim());
}

const MIN_SUBSTANTIAL_GOAL_CHARS = 80;

/**
 * 「继续」类短消息 → 回溯历史找第一条实质性任务描述作为 effective goal。
 */
export function resolveEffectiveUserGoal(
  userMessage: string,
  messages: readonly UnifiedMessage[],
): string {
  if (!isResumeContinuationMessage(userMessage)) {
    return userMessage;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (isSystemInjectedUserContent(msg.content)) continue;
    const t = msg.content.trim();
    if (!t || isResumeContinuationMessage(t)) continue;
    if (t.length >= MIN_SUBSTANTIAL_GOAL_CHARS || hasExecutableSideSignal(t)) {
      return t;
    }
  }

  return userMessage;
}

/** 长跑实现类 benchmark（Supervisor critical 域 + 续跑 goal 继承） */
export function isLongRunningImplementationGoal(goal: string): boolean {
  const t = goal.trim();
  if (t.length < MIN_SUBSTANTIAL_GOAL_CHARS) return false;
  return /implement-|从零实现|验收命令|npm ci|npm test.*npm run build|phase\s*[1-9]|benchMark/i.test(t);
}

export function effectiveIntentForGoal(goal: string) {
  return inferIntent(goal);
}
