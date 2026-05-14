/**
 * 判断 session-notes / checkpoint 之外的「仅笔记 plan」是否应与当前用户一轮合并展示。
 * 避免已完成的旧 plan（100%）或明显新任务仍占住 tracker，导致首轮无法 maybeInit。
 */

import type { ExecutionPlan } from '../types/execution-plan.js';

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
 * 仅从 session-notes hydrate 的 plan：已跑完或与当前输入明显不是同一任务则不恢复。
 */
export function shouldAttachPlanFromSessionNotes(
  plan: Pick<ExecutionPlan, 'goal' | 'progress'>,
  latestUserMessage: string,
): boolean {
  if (plan.progress >= 100) return false;
  return userMessageAlignsWithPersistedGoal(plan.goal, latestUserMessage);
}
