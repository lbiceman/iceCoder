/**
 * 侧栏「任务会话」分组：会话 index 上的 scheduledTaskId 标记 + 任务当前状态。
 *
 * 标记在创建专属会话时写入，任务换绑新会话或被删除后仍保留，
 * 因此旧会话（超大小轮换留下的、任务已删除的）也能归到任务分组。
 */

import type { ScheduledTask } from '../session/scheduled-task-store.js';
import type { SessionMeta } from './session-index-store.js';

const TITLE_PREFIX = '定时任务：';

export function scheduledTaskSessionTitle(taskName: string): string {
  return `${TITLE_PREFIX}${taskName}`;
}

export type ScheduledTaskSessionLink = Pick<ScheduledTask, 'id' | 'name' | 'sessionId'>;
export type ScheduledTaskSessionSource = Pick<ScheduledTask, 'id' | 'sessionId' | 'enabled' | 'nextRunAt' | 'lastStatus'>;

export type ScheduledTaskSessionState =
  | {
    taskId: string;
    state: 'current';
    enabled: boolean;
    nextRunAt: number | null;
    lastStatus: ScheduledTask['lastStatus'];
  }
  /** history：任务已换绑到新会话；deleted：任务已删除 */
  | { taskId: string; state: 'history' | 'deleted' };

/**
 * 给缺标记的任务会话补 scheduledTaskId（兼容标记功能之前创建的会话）：
 * 先按任务当前绑定，再按「定时任务：任务名」标题。返回是否有改动。
 */
export function backfillScheduledTaskSessionMarks(
  index: SessionMeta[],
  tasks: ScheduledTaskSessionLink[],
): boolean {
  const bySession = new Map(tasks.map((t) => [t.sessionId, t.id]));
  const byTitle = new Map<string, string>();
  for (const t of tasks) {
    const title = scheduledTaskSessionTitle(t.name);
    if (!byTitle.has(title)) byTitle.set(title, t.id);
  }
  let changed = false;
  for (const entry of index) {
    if (entry.scheduledTaskId) continue;
    const taskId = bySession.get(entry.id) ?? byTitle.get(entry.title);
    if (!taskId) continue;
    entry.scheduledTaskId = taskId;
    changed = true;
  }
  return changed;
}

/** sessionId → 任务会话状态；普通会话不出现在结果里。 */
export function buildScheduledTaskSessionStates(
  index: SessionMeta[],
  tasks: ScheduledTaskSessionSource[],
): Record<string, ScheduledTaskSessionState> {
  const known = new Set(index.map((s) => s.id));
  const taskIds = new Set(tasks.map((t) => t.id));
  const states: Record<string, ScheduledTaskSessionState> = {};
  for (const t of tasks) {
    if (!known.has(t.sessionId)) continue;
    states[t.sessionId] = {
      taskId: t.id,
      state: 'current',
      enabled: t.enabled,
      nextRunAt: t.nextRunAt,
      lastStatus: t.lastStatus,
    };
  }
  for (const entry of index) {
    if (!entry.scheduledTaskId || states[entry.id]) continue;
    states[entry.id] = {
      taskId: entry.scheduledTaskId,
      state: taskIds.has(entry.scheduledTaskId) ? 'history' : 'deleted',
    };
  }
  return states;
}
