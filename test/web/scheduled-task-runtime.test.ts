import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ScheduledTask } from '../../src/session/scheduled-task-store.js';
import type { ChatRunDeps } from '../../src/web/chat-ws-loop.js';
import {
  buildScheduledTaskInput,
  createScheduledTaskExecutor,
} from '../../src/web/scheduled-task-runtime.js';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: '巡检',
    prompt: '检查依赖更新',
    skillFilenames: [],
    intervalValue: 1,
    intervalUnit: 'hour',
    sessionId: 'sess-1',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    lastRunAt: null,
    nextRunAt: 3_600_000,
    lastStatus: 'idle',
    lastError: null,
    ...overrides,
  };
}

describe('buildScheduledTaskInput', () => {
  it('sends only the prompt when no skills are bound', () => {
    const input = buildScheduledTaskInput(makeTask(), new Set(['a.md']));
    expect(input).toMatchObject({ text: '检查依赖更新', source: 'implicit', scheduledTaskId: 'task-1' });
    expect(input.skills).toBeUndefined();
    expect(input.messageId).toBeTruthy();
  });

  it('prefixes existing skills as #refs and drops missing ones', () => {
    const input = buildScheduledTaskInput(
      makeTask({ skillFilenames: ['a.md', 'gone.md', 'b.md'] }),
      new Set(['a.md', 'b.md']),
    );
    expect(input.text).toBe('#a.md\n#b.md\n检查依赖更新');
    expect(input.skills).toEqual(['a.md', 'b.md']);
  });
});

describe('createScheduledTaskExecutor', () => {
  const chatDeps = {} as ChatRunDeps;

  it('persists the user message then enqueues on the task session with a headless ws', async () => {
    const calls: string[] = [];
    const persistUserMessage = vi.fn(async () => { calls.push('persist'); });
    const enqueue = vi.fn(async () => { calls.push('enqueue'); return 'queued' as never; });
    const execute = createScheduledTaskExecutor({
      chatDeps,
      listSkillFilenames: async () => new Set(['a.md']),
      sessionExists: async () => true,
      persistUserMessage: persistUserMessage as never,
      enqueue: enqueue as never,
    });

    await execute(makeTask({ skillFilenames: ['a.md'] }));

    expect(calls).toEqual(['persist', 'enqueue']);
    const [deps, sid, ws, input] = enqueue.mock.calls[0] as unknown as [ChatRunDeps, string, WebSocket, unknown];
    expect(deps).toBe(chatDeps);
    expect(sid).toBe('sess-1');
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(input).toMatchObject({ text: '#a.md\n检查依赖更新', scheduledTaskId: 'task-1' });
    expect(persistUserMessage).toHaveBeenCalledWith('sess-1', ws, input);
  });

  it('fails without enqueueing when the task session is gone', async () => {
    const enqueue = vi.fn();
    const execute = createScheduledTaskExecutor({
      chatDeps,
      listSkillFilenames: async () => new Set(),
      sessionExists: async () => false,
      persistUserMessage: vi.fn() as never,
      enqueue: enqueue as never,
    });
    await expect(execute(makeTask())).rejects.toThrow('任务会话不存在');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
