import { describe, expect, it } from 'vitest';
import type { SessionMeta } from '../../src/web/session-index-store.js';
import {
  backfillScheduledTaskSessionMarks,
  buildScheduledTaskSessionStates,
  scheduledTaskSessionTitle,
} from '../../src/web/scheduled-task-session-index.js';

function meta(id: string, title: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { id, title, createdAt: 1, updatedAt: 1, messageCount: 0, ...extra };
}

const task = {
  id: 't1',
  name: '巡检',
  sessionId: 's-current',
  enabled: true,
  nextRunAt: 5000,
  lastStatus: 'success' as const,
};

describe('scheduledTaskSessionTitle', () => {
  it('prefixes the task name', () => {
    expect(scheduledTaskSessionTitle('巡检')).toBe('定时任务：巡检');
  });
});

describe('backfillScheduledTaskSessionMarks', () => {
  it('marks the session a task is currently bound to', () => {
    const index = [meta('s-current', '随便改过的名字')];
    expect(backfillScheduledTaskSessionMarks(index, [task])).toBe(true);
    expect(index[0]!.scheduledTaskId).toBe('t1');
  });

  it('marks older sessions whose title matches a task name', () => {
    const index = [meta('s-current', '定时任务：巡检'), meta('s-old', '定时任务：巡检')];
    backfillScheduledTaskSessionMarks(index, [task]);
    expect(index.map((s) => s.scheduledTaskId)).toEqual(['t1', 't1']);
  });

  it('leaves unmatched and already-marked sessions untouched', () => {
    const index = [
      meta('s-plain', '普通会话'),
      meta('s-orphan', '定时任务：早就删掉的任务'),
      meta('s-marked', '定时任务：巡检', { scheduledTaskId: 'other' }),
    ];
    expect(backfillScheduledTaskSessionMarks(index, [{ ...task, sessionId: 'elsewhere' }])).toBe(false);
    expect(index.map((s) => s.scheduledTaskId)).toEqual([undefined, undefined, 'other']);
  });
});

describe('buildScheduledTaskSessionStates', () => {
  it('reports current, history and deleted task sessions; plain sessions are absent', () => {
    const index = [
      meta('s-current', 'a', { scheduledTaskId: 't1' }),
      meta('s-old', 'b', { scheduledTaskId: 't1' }),
      meta('s-gone', 'c', { scheduledTaskId: 't-removed' }),
      meta('s-plain', 'd'),
    ];
    expect(buildScheduledTaskSessionStates(index, [task])).toEqual({
      's-current': { taskId: 't1', state: 'current', enabled: true, nextRunAt: 5000, lastStatus: 'success' },
      's-old': { taskId: 't1', state: 'history' },
      's-gone': { taskId: 't-removed', state: 'deleted' },
    });
  });

  it('treats the bound session as current even if it was never marked', () => {
    const states = buildScheduledTaskSessionStates([meta('s-current', 'a')], [task]);
    expect(states['s-current']).toMatchObject({ taskId: 't1', state: 'current' });
  });

  it('ignores tasks bound to sessions missing from the index', () => {
    expect(buildScheduledTaskSessionStates([], [task])).toEqual({});
  });
});
