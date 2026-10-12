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
import { createScheduledTaskAttachments } from '../../src/web/scheduled-task-attachments.js';
import {
  buildScheduledTaskInput,
  clearStaleScheduledQueueItems,
  createScheduledTaskExecutor,
  ensureScheduledTaskSession,
  isScheduledTaskBusy,
  migrateLegacyScheduledTaskImages,
  recreateScheduledTaskSessionIfMissing,
  scheduledTaskSessionExists,
  rotateScheduledTaskSessionIfOversized,
  stageScheduledTaskImages,
  type ScheduledTaskSessionDeps,
} from '../../src/web/scheduled-task-runtime.js';
import { getSessionsDir, sessionProcessing } from '../../src/web/chat-ws-runtime.js';
import { clearRunningTurn, ensureRunningTurn } from '../../src/web/chat-ws-running-turn.js';
import { getTaskQueueManager } from '../../src/session/task-queue.js';

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
    once: false,
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

  it('sends staged image urls and file reference paths with the prompt', () => {
    const filePath = path.join(os.tmpdir(), 'files', 'f1', '需求.docx');
    const input = buildScheduledTaskInput(
      makeTask({
        skillFilenames: ['a.md'],
        files: [{ id: 'f1', name: '需求.docx', path: filePath, size: 10 }],
      }),
      new Set(['a.md']),
      ['/api/sessions/sess-1/images/x.png'],
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
      persistUserMessage: persistUserMessage as never,
      enqueue: enqueue as never,
      stageImages: async () => [],
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

  it('stages images into and enqueues on the session returned by prepareSession', async () => {
    const enqueue = vi.fn();
    const persistUserMessage = vi.fn();
    const clearStaleQueued = vi.fn(async () => {});
    const stageImages = vi.fn(async (task: ScheduledTask) => [`/api/sessions/${task.sessionId}/images/sched-i1.png`]);
    const execute = createScheduledTaskExecutor({
      chatDeps,
      listSkillFilenames: async () => new Set(),
      persistUserMessage: persistUserMessage as never,
      enqueue: enqueue as never,
      prepareSession: async (task) => ({ ...task, sessionId: 'sess-new' }),
      clearStaleQueued,
      stageImages,
    });
    await execute(makeTask());
    expect(clearStaleQueued.mock.calls[0]![0]).toMatchObject({ sessionId: 'sess-new' });
    expect(stageImages.mock.calls[0]![0]).toMatchObject({ sessionId: 'sess-new' });
    expect(persistUserMessage.mock.calls[0]![0]).toBe('sess-new');
    expect(enqueue.mock.calls[0]![1]).toBe('sess-new');
    expect(enqueue.mock.calls[0]![3]).toMatchObject({ images: ['/api/sessions/sess-new/images/sched-i1.png'] });
  });
});

describe('stageScheduledTaskImages', () => {
  it('copies task images into the session image cache once and skips missing files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-sched-stage-'));
    const sessionId = `stage-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const src = path.join(dir, 'i1', 'shot.png');
      await fs.mkdir(path.dirname(src), { recursive: true });
      await fs.writeFile(src, 'png');
      const task = makeTask({
        sessionId,
        images: [
          { id: 'i1', name: 'shot.png', path: src, size: 3 },
          { id: 'i2', name: 'gone.png', path: path.join(dir, 'i2', 'gone.png'), size: 3 },
        ],
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const first = await stageScheduledTaskImages(task);
      const again = await stageScheduledTaskImages(task);

      expect(first).toHaveLength(1);
      expect(again).toEqual(first);
      expect(first[0]).toMatch(new RegExp(`^/api/sessions/${sessionId}/images/`));
      const cached = await fs.readdir(getImagesCacheSessionDir(sessionId));
      expect(cached).toHaveLength(1);
      expect(await fs.readFile(path.join(getImagesCacheSessionDir(sessionId), cached[0]!), 'utf-8')).toBe('png');
    } finally {
      vi.restoreAllMocks();
      await deleteSessionImagesCache(sessionId);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('scheduled task busy detection and stale queue items', () => {
  const queue = () => getTaskQueueManager(getSessionsDir());
  const sid = () => `sched-busy-${Math.random().toString(36).slice(2, 8)}`;

  it('treats the task as busy only while its session is running', async () => {
    const s = sid();
    const task = makeTask({ sessionId: s });
    try {
      await queue().enqueue(s, { text: 'old', source: 'implicit', scheduledTaskId: task.id });
      expect(await isScheduledTaskBusy(task)).toBe(false);
      sessionProcessing.add(s);
      expect(await isScheduledTaskBusy(task)).toBe(true);
      sessionProcessing.delete(s);
      ensureRunningTurn(s);
      expect(await isScheduledTaskBusy(task)).toBe(true);
    } finally {
      sessionProcessing.delete(s);
      clearRunningTurn(s);
      await queue().clearSession(s);
    }
  });

  it('drops leftover items of the same task while the session is idle, keeping others', async () => {
    const s = sid();
    const task = makeTask({ sessionId: s });
    try {
      await queue().enqueue(s, { text: 'stale', source: 'implicit', scheduledTaskId: task.id });
      await queue().enqueue(s, { text: 'user', source: 'implicit' });
      await queue().enqueue(s, { text: 'other task', source: 'implicit', scheduledTaskId: 'task-2' });
      await clearStaleScheduledQueueItems(task);
      expect((await queue().list(s)).map((i) => i.text)).toEqual(['user', 'other task']);
    } finally {
      await queue().clearSession(s);
    }
  });

  it('keeps queued items while the session is running', async () => {
    const s = sid();
    const task = makeTask({ sessionId: s });
    try {
      await queue().enqueue(s, { text: 'waiting', source: 'implicit', scheduledTaskId: task.id });
      ensureRunningTurn(s);
      await clearStaleScheduledQueueItems(task);
      expect(await queue().list(s)).toHaveLength(1);
    } finally {
      clearRunningTurn(s);
      await queue().clearSession(s);
    }
  });
});

function makeSessionDeps(overrides: Partial<ScheduledTaskSessionDeps> = {}) {
  const rebindSession = vi.fn(async (id: string, sessionId: string) => makeTask({ id, sessionId }));
  const deps: ScheduledTaskSessionDeps = {
    store: { rebindSession },
    createSession: vi.fn(async () => ({ id: 'sess-new' })),
    markSession: vi.fn(async () => {}),
    sessionExists: async () => true,
    sessionBytes: async () => 100,
    maxBytes: 100,
    ...overrides,
  };
  return { deps, rebindSession };
}

describe('recreateScheduledTaskSessionIfMissing', () => {
  it('keeps the task while its session exists, even when oversized', async () => {
    const { deps } = makeSessionDeps({ sessionBytes: async () => 1_000 });
    const task = makeTask();
    expect(await recreateScheduledTaskSessionIfMissing(task, deps)).toBe(task);
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('creates a new session for a deleted one, keeping images and schedule', async () => {
    const { deps, rebindSession } = makeSessionDeps({ sessionExists: async () => false });
    const image = { id: 'i1', name: 'a.png', path: '/task-files/i1/a.png', size: 1 };
    const rebound = await recreateScheduledTaskSessionIfMissing(makeTask({ images: [image] }), deps);
    expect(deps.createSession).toHaveBeenCalledWith('定时任务：巡检');
    expect(rebindSession).toHaveBeenCalledWith('task-1', 'sess-new');
    expect(deps.markSession).toHaveBeenCalledWith('sess-new', 'task-1');
    expect(rebound.sessionId).toBe('sess-new');
  });

  it('creates the first session for a task that has never run', async () => {
    const sessionExists = vi.fn(async () => true);
    const { deps, rebindSession } = makeSessionDeps({ sessionExists });
    const rebound = await recreateScheduledTaskSessionIfMissing(makeTask({ sessionId: '' }), deps);
    expect(sessionExists).not.toHaveBeenCalled();
    expect(deps.createSession).toHaveBeenCalledWith('定时任务：巡检');
    expect(rebindSession).toHaveBeenCalledWith('task-1', 'sess-new');
    expect(deps.markSession).toHaveBeenCalledWith('sess-new', 'task-1');
    expect(rebound.sessionId).toBe('sess-new');
  });
});

describe('scheduledTaskSessionExists', () => {
  it('treats an empty session id as missing', async () => {
    expect(await scheduledTaskSessionExists('')).toBe(false);
  });
});

describe('ensureScheduledTaskSession', () => {
  it('keeps the task when its session exists and is under the limit', async () => {
    const { deps } = makeSessionDeps({ sessionBytes: async () => 99 });
    const task = makeTask();
    expect(await ensureScheduledTaskSession(task, deps)).toBe(task);
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('recreates a deleted session without checking its size', async () => {
    const sessionBytes = vi.fn(async () => 1_000);
    const { deps, rebindSession } = makeSessionDeps({ sessionExists: async () => false, sessionBytes });
    const rebound = await ensureScheduledTaskSession(makeTask(), deps);
    expect(rebindSession).toHaveBeenCalledTimes(1);
    expect(rebindSession).toHaveBeenCalledWith('task-1', 'sess-new');
    expect(sessionBytes).not.toHaveBeenCalled();
    expect(rebound.sessionId).toBe('sess-new');
  });

  it('rotates an existing oversized session', async () => {
    const { deps, rebindSession } = makeSessionDeps({ sessionBytes: async () => 100 });
    await ensureScheduledTaskSession(makeTask(), deps);
    expect(rebindSession).toHaveBeenCalledWith('task-1', 'sess-new');
  });
});

describe('rotateScheduledTaskSessionIfOversized', () => {
  const makeDeps = makeSessionDeps;

  it('keeps the task untouched while the session is under the limit', async () => {
    const { deps } = makeDeps({ sessionBytes: async () => 99 });
    const task = makeTask();
    expect(await rotateScheduledTaskSessionIfOversized(task, deps)).toBe(task);
    expect(deps.createSession).not.toHaveBeenCalled();
  });

  it('creates a new session and rebinds the task', async () => {
    const { deps, rebindSession } = makeDeps();
    const rotated = await rotateScheduledTaskSessionIfOversized(makeTask(), deps);
    expect(deps.createSession).toHaveBeenCalledWith('定时任务：巡检');
    expect(rebindSession).toHaveBeenCalledWith('task-1', 'sess-new');
    expect(deps.markSession).toHaveBeenCalledWith('sess-new', 'task-1');
    expect(rotated.sessionId).toBe('sess-new');
  });

  it('keeps the rebound task when marking the new session fails', async () => {
    const { deps } = makeDeps({ markSession: vi.fn(async () => { throw new Error('index busy'); }) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rotated = await rotateScheduledTaskSessionIfOversized(makeTask(), deps);
    expect(rotated.sessionId).toBe('sess-new');
  });
});

describe('ScheduledTaskStore.rebindSession', () => {
  it('rebinds the session without touching images or the schedule', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-sched-rebind-'));
    try {
      let now = 1_000;
      const store = new ScheduledTaskStore(path.join(dir, 'tasks.json'), () => now);
      const image = { id: 'i1', name: 'a.png', path: path.join(dir, 'i1', 'a.png'), size: 1 };
      const created = await store.create({
        name: 'n', prompt: 'p', skillFilenames: [], intervalValue: 1, intervalUnit: 'hour', enabled: true,
        sessionId: 's-old', images: [image],
      });
      now = 5_000;
      const rebound = await store.rebindSession(created.id, 's-new');
      expect(rebound).toMatchObject({
        sessionId: 's-new',
        images: [image],
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

describe('migrateLegacyScheduledTaskImages', () => {
  it('moves legacy session image urls into task-owned files and drops missing ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-sched-migrate-'));
    const sessionId = `mig-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const [saved] = await persistInlineImages(['data:image/png;base64,iVBORw0KGgo='], sessionId);
      const url = buildSessionImageApiUrl(sessionId, saved!.absolutePath);
      const filePath = path.join(dir, 'tasks.json');
      const legacy = {
        id: 'old', name: '旧任务', prompt: 'p', skillFilenames: [], intervalValue: 1, intervalUnit: 'hour',
        sessionId, enabled: true, createdAt: 0, updatedAt: 0, lastRunAt: null, nextRunAt: 3_600_000,
        lastStatus: 'idle', lastError: null, files: [],
        images: [url, `/api/sessions/${sessionId}/images/gone.png`],
      };
      await fs.writeFile(filePath, JSON.stringify({ version: 1, tasks: [legacy] }), 'utf-8');
      const store = new ScheduledTaskStore(filePath);
      const attachments = createScheduledTaskAttachments({ filesRoot: path.join(dir, 'task-files') });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await migrateLegacyScheduledTaskImages(store, attachments);
      await deleteSessionImagesCache(sessionId);

      const task = await store.get('old');
      expect(task?.legacyImageUrls).toBeUndefined();
      expect(task?.images).toHaveLength(1);
      expect(task!.images[0]!.path.startsWith(path.join(dir, 'task-files'))).toBe(true);
      await expect(fs.readFile(task!.images[0]!.path)).resolves.toBeTruthy();
      expect(task?.nextRunAt).toBe(3_600_000);
    } finally {
      vi.restoreAllMocks();
      await deleteSessionImagesCache(sessionId);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
