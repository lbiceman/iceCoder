/**
 * 判断 session-notes / checkpoint 中的持久化 plan 是否应挂载到本轮 tracker。
 * 避免已完成的旧 plan（100%）、checkpoint 与用户新目标不一致、或多段任务第一段跑满后占位导致无法重建计划。
 */

import type { ExecutionPlan } from '../types/execution-plan.js';
import type { TaskIntent, TaskStateSnapshot } from '../types/runtime-snapshot.js';

/** 与 harness 任务切换检测同阈值的 Jaccard（低于则视为新主题） */
export const PLAN_SESSION_JACCARD_THRESHOLD = 0.15;

export function bigramJaccard(a: string, b: string): number {
  if (!a || !b) return 0;
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.substring(i, i + 2));
    }
    return set;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 用户本轮输入是否与持久化 goal 视为同一任务链（含短续跑话术）。
 */
export function userMessageAlignsWithPersistedGoal(
  persistedGoal: string,
  latestUserMessage: string,
): boolean {
  const u = latestUserMessage.trim();
  const g = persistedGoal.trim();
  if (!u || !g) return false;
  // 续跑短句：不用 \b（CJK 与 \w 边界不可靠）
  if (/^(继续|接着|接下來|接下|同上)([，。、\s]|$)/u.test(u)) return true;
  if (/^帮我继续/u.test(u) || /^請繼續/u.test(u)) return true;
  if (/^continue(\s|,|;|:|\.|$)/i.test(u) || /^resume(\s|,|;|:|\.|$)/i.test(u)) return true;
  if (g === u) return true;
  const longEnough = Math.min(g.length, u.length) >= 24;
  if (longEnough && (g.includes(u) || u.includes(g))) return true;
  return bigramJaccard(g, u) >= PLAN_SESSION_JACCARD_THRESHOLD;
}

/**
 * 持久化 plan（会话笔记或 checkpoint）是否仍与「本轮用户输入 + 可选的 checkpoint.userGoal」同一任务链。
 */
export function shouldAttachPersistedExecutionPlan(
  plan: Pick<ExecutionPlan, 'goal' | 'progress'>,
  latestUserMessage: string,
  alternatePersistedGoals: string[] = [],
): boolean {
  if (plan.progress >= 100) return false;
  if (userMessageAlignsWithPersistedGoal(plan.goal, latestUserMessage)) return true;
  for (const alt of alternatePersistedGoals) {
    if (alt.trim() && userMessageAlignsWithPersistedGoal(alt, latestUserMessage)) return true;
  }
  return false;
}

/**
 * 仅从 session-notes hydrate 的 plan：已跑完或与当前输入明显不是同一任务则不恢复。
 */
export function shouldAttachPlanFromSessionNotes(
  plan: Pick<ExecutionPlan, 'goal' | 'progress'>,
  latestUserMessage: string,
): boolean {
  return shouldAttachPersistedExecutionPlan(plan, latestUserMessage);
}

/** 由 TaskState 快照推断「当前实质工作」更偏哪类计划模板（粗粒度）。 */
export function inferWorkIntentFromTaskSnapshot(snap: TaskStateSnapshot): TaskIntent {
  if (snap.phase === 'verification') return 'test';
  if (snap.phase === 'editing') return 'edit';
  if (snap.filesChanged.length > 0) return 'edit';
  if (snap.verificationRequired) return 'test';
  return 'inspect';
}

/**
 * 同一条用户消息里多段任务：inspect 计划已跑满 100%，但仍在做实现/测试/写文档类工作时，应换一套计划。
 */
export function shouldRefreshTerminalInspectPlan(
  plan: Pick<ExecutionPlan, 'intent' | 'progress'>,
  snap: TaskStateSnapshot,
  latestUserMessage: string,
): boolean {
  if (plan.progress < 100) return false;
  if (plan.intent !== 'inspect') return false;
  const work = inferWorkIntentFromTaskSnapshot(snap);
  if (work !== 'inspect') return true;
  const t = latestUserMessage;
  if (/创建|新增|写入|实现|修改|编辑|跑|测试|文档|部署|write|create|implement|modify|edit|run|test|docs/i.test(t)) {
    return true;
  }
  return false;
}
