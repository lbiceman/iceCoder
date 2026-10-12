import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduledTaskStore } from '../../../src/session/scheduled-task-store.js';
import { createScheduledTasksRouter } from '../../../src/web/routes/scheduled-tasks.js';
import { SCHEDULED_TASK_BUSY_MESSAGE } from '../../../src/session/scheduled-task-scheduler.js';
import {
  ATTACHMENT_EXPIRED_MESSAGE,
  createScheduledTaskAttachments,
} from '../../../src/web/scheduled-task-attachments.js';

describe('scheduled tasks router', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: ScheduledTaskStore;
  let now: number;
  let uploads: Map<string, { originalName: string; filePath: string; size: number }>;
  const scheduler = { reschedule: vi.fn(async () => {}), runNow: vi.fn(async (_id: string) => {}) };
  const createSession = vi.fn(async (_title: string) => ({ id: 'sess-1' }));

  async function fakeUpload(id: string, name: string, content = 'x') {
    const filePath = path.join(dir, 'tmp-uploads', `${id}${path.extname(name)}`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    uploads.set(id, { originalName: name, filePath, size: content.length });
  }

  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  }

  const validInput = { name: '巡检', prompt: '检查依赖', intervalValue: 5, intervalUnit: 'minute', skillFilenames: ['a.md'] };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-sched-route-'));
    now = 1_000_000;
    store = new ScheduledTaskStore(path.join(dir, 'tasks.json'), () => now);
    scheduler.reschedule.mockClear();
    scheduler.runNow.mockClear();
    createSession.mockClear();
    uploads = new Map();
    const attachments = createScheduledTaskAttachments({
      filesRoot: path.join(dir, 'task-files'),
      lookupUpload: (id) => uploads.get(id),
      persistImage: async (src, sid) => `/api/sessions/${sid}/images/${path.basename(src)}`,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/scheduled-tasks', createScheduledTasksRouter({ store, scheduler, createSession, attachments }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a task with a dedicated session and reschedules', async () => {
    const res = await call('POST', '/api/scheduled-tasks', validInput);
    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith('定时任务：巡检');
    expect(res.body.task).toMatchObject({
      name: '巡检',
      sessionId: 'sess-1',
      enabled: true,
      skillFilenames: ['a.md'],
      nextRunAt: now + 5 * 60_000,
    });
    expect(scheduler.reschedule).toHaveBeenCalledTimes(1);

    const list = await call('GET', '/api/scheduled-tasks');
    expect(list.body.tasks).toHaveLength(1);
    expect(typeof list.body.now).toBe('number');
  });

  it('rejects invalid input with 400 and does not create a session', async () => {
    for (const bad of [
      { ...validInput, name: ' ' },
      { ...validInput, prompt: '' },
      { ...validInput, intervalValue: 0 },
      { ...validInput, intervalValue: 1.5 },
      { ...validInput, intervalUnit: 'week' },
    ]) {
      const res = await call('POST', '/api/scheduled-tasks', bad);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
    expect(createSession).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(0);
  });

  it('edits, toggles, runs and deletes', async () => {
    const { body: created } = await call('POST', '/api/scheduled-tasks', validInput);
    const id = created.task.id as string;

    now += 1000;
    const edited = await call('PUT', `/api/scheduled-tasks/${id}`, { intervalValue: 2, intervalUnit: 'hour' });
    expect(edited.body.task).toMatchObject({ intervalValue: 2, intervalUnit: 'hour', nextRunAt: now + 2 * 3_600_000 });

    const off = await call('POST', `/api/scheduled-tasks/${id}/toggle`);
    expect(off.body.task).toMatchObject({ enabled: false, nextRunAt: null });
    const on = await call('POST', `/api/scheduled-tasks/${id}/toggle`, { enabled: true });
    expect(on.body.task.enabled).toBe(true);

    const run = await call('POST', `/api/scheduled-tasks/${id}/run`);
    expect(run.status).toBe(200);
    expect(scheduler.runNow).toHaveBeenCalledWith(id);

    const del = await call('DELETE', `/api/scheduled-tasks/${id}`);
    expect(del.body.success).toBe(true);
    expect(await store.list()).toHaveLength(0);
    expect(scheduler.reschedule).toHaveBeenCalledTimes(5);
  });

  it('returns 404 for unknown tasks', async () => {
    expect((await call('PUT', '/api/scheduled-tasks/nope', { name: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/api/scheduled-tasks/nope')).status).toBe(404);
    expect((await call('POST', '/api/scheduled-tasks/nope/toggle')).status).toBe(404);
  });

  it('returns 409 when run-now hits a busy task', async () => {
    const { body: created } = await call('POST', '/api/scheduled-tasks', validInput);
    scheduler.runNow.mockRejectedValueOnce(new Error(SCHEDULED_TASK_BUSY_MESSAGE));
    const res = await call('POST', `/api/scheduled-tasks/${created.task.id}/run`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(SCHEDULED_TASK_BUSY_MESSAGE);
  });

  it('persists uploaded images and files on create', async () => {
    await fakeUpload('up-img', 'shot.png');
    await fakeUpload('up-doc', '需求 说明.docx', 'hello');
    const res = await call('POST', '/api/scheduled-tasks', {
      ...validInput,
      images: [{ uploadId: 'up-img' }],
      files: [{ uploadId: 'up-doc' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.task.images).toEqual(['/api/sessions/sess-1/images/up-img.png']);
    const [file] = res.body.task.files;
    expect(file).toMatchObject({ name: '需求 说明.docx', size: 5 });
    expect(file.path.startsWith(path.join(dir, 'task-files', 'sess-1'))).toBe(true);
    expect(path.basename(file.path)).toBe('需求 说明.docx');
    expect(await fs.readFile(file.path, 'utf-8')).toBe('hello');
  });

  it('rejects expired uploads with 400 before creating a session', async () => {
    const res = await call('POST', '/api/scheduled-tasks', { ...validInput, files: [{ uploadId: 'gone' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ATTACHMENT_EXPIRED_MESSAGE);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('rejects malformed attachment refs with 400', async () => {
    const res = await call('POST', '/api/scheduled-tasks', { ...validInput, images: ['data:image/png;base64,xx'] });
    expect(res.status).toBe(400);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('edit keeps referenced attachments, deletes dropped files, ignores foreign urls', async () => {
    await fakeUpload('a', 'a.txt');
    await fakeUpload('b', 'b.txt');
    await fakeUpload('img', 'p.png');
    const { body: created } = await call('POST', '/api/scheduled-tasks', {
      ...validInput,
      images: [{ uploadId: 'img' }],
      files: [{ uploadId: 'a' }, { uploadId: 'b' }],
    });
    const [fileA, fileB] = created.task.files;
    const imageUrl = created.task.images[0];

    const edited = await call('PUT', `/api/scheduled-tasks/${created.task.id}`, {
      images: [{ url: imageUrl }, { url: '/api/sessions/other/images/evil.png' }],
      files: [{ id: fileB.id }, { id: 'unknown' }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.task.images).toEqual([imageUrl]);
    expect(edited.body.task.files).toEqual([fileB]);
    await expect(fs.access(fileA.path)).rejects.toThrow();
    await expect(fs.access(fileB.path)).resolves.toBeUndefined();

    const untouched = await call('PUT', `/api/scheduled-tasks/${created.task.id}`, { name: '改名' });
    expect(untouched.body.task.files).toEqual([fileB]);
    expect(untouched.body.task.images).toEqual([imageUrl]);
  });

  it('edit rolls back newly copied files when validation fails', async () => {
    const { body: created } = await call('POST', '/api/scheduled-tasks', validInput);
    await fakeUpload('n', 'n.txt');
    const res = await call('PUT', `/api/scheduled-tasks/${created.task.id}`, {
      name: ' ',
      files: [{ uploadId: 'n' }],
    });
    expect(res.status).toBe(400);
    const sessionDir = path.join(dir, 'task-files', 'sess-1');
    const left = await fs.readdir(sessionDir).catch(() => []);
    expect(left).toEqual([]);
  });

  it('delete removes the task file attachments', async () => {
    await fakeUpload('d', 'd.txt');
    const { body: created } = await call('POST', '/api/scheduled-tasks', { ...validInput, files: [{ uploadId: 'd' }] });
    const filePath = created.task.files[0].path as string;
    await call('DELETE', `/api/scheduled-tasks/${created.task.id}`);
    await expect(fs.access(filePath)).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'task-files', 'sess-1'))).rejects.toThrow();
  });

  it('returns 500 when session creation fails', async () => {
    createSession.mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('POST', '/api/scheduled-tasks', validInput);
    expect(res.status).toBe(500);
    expect(await store.list()).toHaveLength(0);
  });
});
