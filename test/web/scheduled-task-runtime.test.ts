import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { ScheduledTask } from '../../src/session/scheduled-task-store.js';
import type { ChatRunDeps } from '../../src/web/chat-ws-loop.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduledTaskStore } from '../../src/session/scheduled-task-store.js';
import { getImagesCacheSessionDir } from '../../src/cli/paths.js';
import {
  buildSessionImageApiUrl,
  deleteSessionImagesCache,
  persistInlineImages,
} from '../../src/web/images-cache.js';
import {
  buildScheduledTaskInput,
  createScheduledTaskExecutor,
  disableScheduledTasksForSession,
  rotateScheduledTaskSessionIfOversized,
  SCHEDULED_TASK_SESSION_DELETED,
  type ScheduledTaskSessionRotationDeps,
} from '../../src/web/scheduled-task-runtime.js';

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 'task-1',
    name: '巡检',
    prompt: '检查依赖更新',
    skillFilenames: [],
    images: [],
    files: [],
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

  it('sends images and file reference paths with the prompt', () => {
    const filePath = path.join(os.tmpdir(), 'files', 'f1', '需求.docx');
    const input = buildScheduledTaskInput(
      makeTask({
        skillFilenames: ['a.md'],
        images: ['/api/sessions/sess-1/images/x.png'],
        files: [{ id: 'f1', name: '需求.docx', path: filePath, size: 10 }],
      }),
      new Set(['a.md']),
    );
    expect(input.text).toBe(`#a.md\n${filePath}\n检查依赖更新`);
    expect(input.referencePaths).toEqual([filePath]);
    expect(input.images).toEqual(['/api/sessions/sess-1/images/x.png']);
  });

  it('omits images and referencePaths when the task has none', () => {
    const input = buildScheduledTaskInput(makeTask(), new Set());
    expect(input.images).toBeUndefined();
    expect(input.referencePaths).toBeUndefined();
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

  it('enqueues on the rotated session when rotation rebinds the task', async () => {
    const enqueue = vi.fn();
    const execute = createScheduledTaskExecutor({
      chatDeps,
      listSkillFilenames: async () => new Set(),
      sessionExists: async () => true,
      persistUserMessage: vi.fn() as never,
      enqueue: enqueue as never,
      rotateSession: async (task) => ({ ...task, sessionId: 'sess-new' }),
    });
    await execute(makeTask());
    expect(enqueue.mock.calls[0]![1]).toBe('sess-new');
  });
});

describe('rotateScheduledTaskSessionIfOversized', () => {
  function makeDeps(overrides: Partial<ScheduledTaskSessionRotationDeps> = {}) {
    const rebindSession = vi.fn(async (id: string, sessionId: string, images: string[]) =>
      makeTask({ id, sessionId, images }));
    const deps: ScheduledTaskSessionRotationDeps = {
      store: { rebindSession },
      createSession: vi.fn(async () => ({ id: 'sess-new' })),
      sessionBytes: async () => 100,
      copyImage: async (url) => url.replace('sess-1', 'sess-new'),
      maxBytes: 100,
      ...overrides,
    };
    return { deps, rebindSession };
  }

  it('keeps the task untouched while the session is under the limit', async () => {
    const { deps } = makeDeps({ sessionBytes: async () => 99 });
    const task = makeTask();
    expect(await rotateScheduledTaskSessionIfOversized(task, deps)).toBe(task);
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('creates a new session, migrates images and rebinds the task', async () => {
    const { deps, rebindSession } = makeDeps();
    const rotated = await rotateScheduledTaskSessionIfOversized(
      makeTask({ images: ['/api/sessions/sess-1/images/a.png'] }),
      deps,
    );
    expect(deps.createSession).toHaveBeenCalledWith('定时任务：巡检');
    expect(rebindSession).toHaveBeenCalledWith('task-1', 'sess-new', ['/api/sessions/sess-new/images/a.png']);
    expect(rotated.sessionId).toBe('sess-new');
  });

  it('falls back to the old image url when an image could not be migrated', async () => {
    const { deps, rebindSession } = makeDeps({ copyImage: async () => { throw new Error('io'); } });
    await rotateScheduledTaskSessionIfOversized(makeTask({ images: ['/api/sessions/sess-1/images/a.png'] }), deps);
    expect(rebindSession).toHaveBeenCalledWith('task-1', 'sess-new', ['/api/sessions/sess-1/images/a.png']);
  });

  it('copies task images into the new session image cache by default', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const from = `rot-old-${suffix}`;
    const to = `rot-new-${suffix}`;
    try {
      const [saved] = await persistInlineImages(['data:image/png;base64,iVBORw0KGgo='], from);
      const url = buildSessionImageApiUrl(from, saved!.absolutePath);
      const { deps, rebindSession } = makeDeps({ createSession: async () => ({ id: to }), copyImage: undefined });
      await rotateScheduledTaskSessionIfOversized(makeTask({ sessionId: from, images: [url] }), deps);
      const [, , images] = rebindSession.mock.calls[0]!;
      expect(images).toHaveLength(1);
      expect(images[0]).toMatch(new RegExp(`^/api/sessions/${to}/images/`));
      const copied = path.join(getImagesCacheSessionDir(to), decodeURIComponent(images[0]!.split('/').pop()!));
      await expect(fs.readFile(copied)).resolves.toBeTruthy();
      await expect(fs.readFile(saved!.absolutePath)).resolves.toBeTruthy();
    } finally {
      await deleteSessionImagesCache(from);
      await deleteSessionImagesCache(to);
    }
  });
});

describe('ScheduledTaskStore.rebindSession', () => {
  it('rebinds the session and images without touching the schedule', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-sched-rebind-'));
    try {
      let now = 1_000;
      const store = new ScheduledTaskStore(path.join(dir, 'tasks.json'), () => now);
      const created = await store.create({
        name: 'n', prompt: 'p', skillFilenames: [], intervalValue: 1, intervalUnit: 'hour', enabled: true,
        sessionId: 's-old', images: ['/api/sessions/s-old/images/a.png'],
      });
      now = 5_000;
      const rebound = await store.rebindSession(created.id, 's-new', ['/api/sessions/s-new/images/b.png']);
      expect(rebound).toMatchObject({
        sessionId: 's-new',
        images: ['/api/sessions/s-new/images/b.png'],
        nextRunAt: created.nextRunAt,
        enabled: true,
        updatedAt: 5_000,
      });
      const reloaded = new ScheduledTaskStore(path.join(dir, 'tasks.json'));
      expect((await reloaded.get(created.id))?.sessionId).toBe('s-new');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('disableScheduledTasksForSession', () => {
  it('disables only tasks bound to the deleted session and records why', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-sched-del-'));
    try {
      const store = new ScheduledTaskStore(path.join(dir, 'tasks.json'), () => 1_000);
      const base = { prompt: 'p', skillFilenames: [], intervalValue: 1, intervalUnit: 'hour' as const, enabled: true };
      const gone = await store.create({ ...base, name: 'gone', sessionId: 's-gone' });
      const kept = await store.create({ ...base, name: 'kept', sessionId: 's-kept' });

      expect(await disableScheduledTasksForSession(store, 's-gone')).toBe(1);

      expect(await store.get(gone.id)).toMatchObject({
        enabled: false,
        nextRunAt: null,
        lastStatus: 'error',
        lastError: SCHEDULED_TASK_SESSION_DELETED,
      });
      expect(await store.get(kept.id)).toMatchObject({ enabled: true, lastStatus: 'idle' });
      expect(await disableScheduledTasksForSession(store, 's-none')).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
