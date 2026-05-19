/**
 * TaskGraph 配置与 Feature Flag。
 *
 * 依赖：无
 */

/** 读取 ICE_TASK_GRAPH 环境变量，判断是否启用 TaskGraph */
export function isTaskGraphEnabled(): boolean {
  const env = process.env['ICE_TASK_GRAPH'];
  if (env === undefined || env === '') return false;
  return env !== '0' && env.toLowerCase() !== 'false';
}

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
