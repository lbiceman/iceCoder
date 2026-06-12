/**
 * TaskGraph 域门控：按任务 intent 决定是否初始化图监督。
 */

// ═══════════════════════════════════════════════
// TaskDomainGate (Phase 12)
// ═══════════════════════════════════════════════

import type { TaskIntent } from '../types/runtime-snapshot.js';

/** 需要 TaskGraph 监督的任务意图（多步、有副作用） */
const TASKGRAPH_INTENTS: ReadonlySet<TaskIntent> = new Set([
  'edit',
  'debug',
  'test',
  'refactor',
]);

/**
 * 判定当前任务是否应初始化 TaskGraph。
 * 仅 multi-step / 有副作用的 intent 才进入 graph 监督。
 * question / inspect 等自由对话保持 free mode。
 */
export function shouldUseTaskGraph(intent: TaskIntent): boolean {
  return TASKGRAPH_INTENTS.has(intent);
}
