import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduledTaskStore, type ScheduledTask } from '../../../src/session/scheduled-task-store.js';
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
  const sessionExists = vi.fn(async (_sessionId: string) => true);

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
    sessionExists.mockReset();
    sessionExists.mockImplementation(async () => true);
    uploads = new Map();
    const attachments = createScheduledTaskAttachments({
      filesRoot: path.join(dir, 'task-files'),
      lookupUpload: (id) => uploads.get(id),
    });
    const app = express();
    app.use(express.json());
    app.use('/api/scheduled-tasks', createScheduledTasksRouter({ store, scheduler, sessionExists, attachments }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates a task without a session and reschedules', async () => {
    const res = await call('POST', '/api/scheduled-tasks', validInput);
    expect(res.status).toBe(200);
    expect(res.body.task).toMatchObject({
      name: '巡检',
      sessionId: '',
      enabled: true,
      skillFilenames: ['a.md'],
      nextRunAt: now + 5 * 60_000,
    });
    expect(scheduler.reschedule).toHaveBeenCalledTimes(1);

    const list = await call('GET', '/api/scheduled-tasks');
    expect(list.body.tasks).toHaveLength(1);
  });

  it('rejects invalid input with 400 and creates nothing', async () => {
    for (const bad of [
      { ...validInput, name: ' ' },
      { ...validInput, prompt: '' },
      { ...validInput, intervalValue: 0 },
      { ...validInput, intervalValue: 1.5 },
      { ...validInput, intervalUnit: 'week' },
      { ...validInput, scheduleKind: 'monthly', timeOfDay: '10:00' },
      { ...validInput, scheduleKind: 'daily', timeOfDay: '7点' },
      { ...validInput, scheduleKind: 'weekly', timeOfDay: '10:00', weekdays: [] },
      { ...validInput, scheduleKind: 'weekly', timeOfDay: '10:00', weekdays: [8] },
    ]) {
      const res = await call('POST', '/api/scheduled-tasks', bad);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
    expect(await store.list()).toHaveLength(0);
  });

  it('edits, toggles, runs and deletes', async () => {
    const { body: created } = await call('POST', '/api/scheduled-tasks', validInput);
    const id = created.task.id as string;

    now += 1000;
    const edited = await call('PUT', `/api/scheduled-tasks/${id}`, { intervalValue: 2, intervalUnit: 'hour' });
    expect(edited.body.task).toMatchObject({ intervalValue: 2, intervalUnit: 'hour', nextRunAt: now + 2 * 3_600_000 });

    const weekly = await call('PUT', `/api/scheduled-tasks/${id}`, { scheduleKind: 'weekly', weekdays: ['5'], timeOfDay: '10:00' });
    expect(weekly.status).toBe(200);
    expect(weekly.body.task).toMatchObject({ scheduleKind: 'weekly', weekdays: [5], timeOfDay: '10:00' });
    expect(new Date(weekly.body.task.nextRunAt).getDay()).toBe(5);
    expect(weekly.body.task.nextRunAt).toBeGreaterThan(now);
    await call('PUT', `/api/scheduled-tasks/${id}`, { scheduleKind: 'interval', intervalValue: 2, intervalUnit: 'hour' });

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
    expect(scheduler.reschedule).toHaveBeenCalledTimes(7);
  });

  it('creates and edits one-time tasks; edits without once keep it', async () => {
    const plain = await call('POST', '/api/scheduled-tasks', validInput);
    expect(plain.body.task.once).toBe(false);

    const created = await call('POST', '/api/scheduled-tasks', { ...validInput, once: true });
    const id = created.body.task.id as string;
    expect(created.body.task).toMatchObject({ once: true, enabled: true, nextRunAt: now + 5 * 60_000 });

    const renamed = await call('PUT', `/api/scheduled-tasks/${id}`, { name: '改名' });
    expect(renamed.body.task.once).toBe(true);
    const repeat = await call('PUT', `/api/scheduled-tasks/${id}`, { once: false });
    expect(repeat.body.task.once).toBe(false);
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
    const [image] = res.body.task.images;
    const taskDir = path.join(dir, 'task-files', res.body.task.id);
    expect(image).toMatchObject({ name: 'shot.png', size: 1 });
    expect(image.path.startsWith(taskDir + path.sep)).toBe(true);
    expect(await fs.readFile(image.path, 'utf-8')).toBe('x');
    const [file] = res.body.task.files;
    expect(file).toMatchObject({ name: '需求 说明.docx', size: 5 });
    expect(file.path.startsWith(taskDir + path.sep)).toBe(true);
    expect(path.basename(file.path)).toBe('需求 说明.docx');
    expect(await fs.readFile(file.path, 'utf-8')).toBe('hello');
  });

  it('rejects expired uploads with 400 and creates nothing', async () => {
    const res = await call('POST', '/api/scheduled-tasks', { ...validInput, files: [{ uploadId: 'gone' }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ATTACHMENT_EXPIRED_MESSAGE);
    expect(await store.list()).toHaveLength(0);
  });

  it('rejects malformed attachment refs with 400', async () => {
    const res = await call('POST', '/api/scheduled-tasks', { ...validInput, images: ['data:image/png;base64,xx'] });
    expect(res.status).toBe(400);
    expect(await store.list()).toHaveLength(0);
  });

  it('edit keeps referenced attachments, deletes dropped ones, ignores unknown ids', async () => {
    await fakeUpload('a', 'a.txt');
    await fakeUpload('b', 'b.txt');
    await fakeUpload('img1', 'p1.png');
    await fakeUpload('img2', 'p2.png');
    const { body: created } = await call('POST', '/api/scheduled-tasks', {
      ...validInput,
      images: [{ uploadId: 'img1' }, { uploadId: 'img2' }],
      files: [{ uploadId: 'a' }, { uploadId: 'b' }],
    });
    const [fileA, fileB] = created.task.files;
    const [image1, image2] = created.task.images;

    const edited = await call('PUT', `/api/scheduled-tasks/${created.task.id}`, {
      images: [{ id: image2.id }, { id: 'evil' }],
      files: [{ id: fileB.id }, { id: 'unknown' }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.task.images).toEqual([image2]);
    expect(edited.body.task.files).toEqual([fileB]);
    await expect(fs.access(fileA.path)).rejects.toThrow();
    await expect(fs.access(image1.path)).rejects.toThrow();
    await expect(fs.access(fileB.path)).resolves.toBeUndefined();
    await expect(fs.access(image2.path)).resolves.toBeUndefined();

    const untouched = await call('PUT', `/api/scheduled-tasks/${created.task.id}`, { name: '改名' });
    expect(untouched.body.task.files).toEqual([fileB]);
    expect(untouched.body.task.images).toEqual([image2]);
  });

  it('serves task images by id and 404s unknown ones', async () => {
    await fakeUpload('img', 'p.png', 'png-bytes');
    const { body: created } = await call('POST', '/api/scheduled-tasks', { ...validInput, images: [{ uploadId: 'img' }] });
    const id = created.task.id as string;
    const imageId = created.task.images[0].id as string;

    const ok = await fetch(`${base}/api/scheduled-tasks/${id}/images/${imageId}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('png-bytes');
    expect((await fetch(`${base}/api/scheduled-tasks/${id}/images/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/scheduled-tasks/nope/images/${imageId}`)).status).toBe(404);
  });

  it('opening the session never creates one: not ready before the first run', async () => {
    const { body: created } = await call('POST', '/api/scheduled-tasks', validInput);
    const res = await call('POST', `/api/scheduled-tasks/${created.task.id}/session`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionReady: false, task: { id: created.task.id, sessionId: '' } });
    expect(sessionExists).not.toHaveBeenCalled();
    expect((await call('POST', '/api/scheduled-tasks/nope/session')).status).toBe(404);
  });

  it('opening the session reports whether the bound session still exists', async () => {
    const { body: created } = await call('POST', '/api/scheduled-tasks', validInput);
    await store.rebindSession(created.task.id, 'sess-run');
    const ready = await call('POST', `/api/scheduled-tasks/${created.task.id}/session`);
    expect(ready.body).toMatchObject({ sessionReady: true, task: { sessionId: 'sess-run' } });
    expect(sessionExists).toHaveBeenCalledWith('sess-run');

    sessionExists.mockResolvedValueOnce(false);
    const deleted = await call('POST', `/api/scheduled-tasks/${created.task.id}/session`);
    expect(deleted.body).toMatchObject({ sessionReady: false, task: { sessionId: 'sess-run' } });
  });

  it('edit rolls back newly copied files when validation fails', async () => {
    const { body: created } = await call('POST', '/api/scheduled-tasks', validInput);
    await fakeUpload('n', 'n.txt');
    const res = await call('PUT', `/api/scheduled-tasks/${created.task.id}`, {
      name: ' ',
      files: [{ uploadId: 'n' }],
    });
    expect(res.status).toBe(400);
    const taskDir = path.join(dir, 'task-files', created.task.id);
    const left = await fs.readdir(taskDir).catch(() => []);
    expect(left).toEqual([]);
  });

  it('delete removes the task file and image attachments', async () => {
    await fakeUpload('d', 'd.txt');
    await fakeUpload('i', 'i.png');
    const { body: created } = await call('POST', '/api/scheduled-tasks', {
      ...validInput,
      images: [{ uploadId: 'i' }],
      files: [{ uploadId: 'd' }],
    });
    const filePath = created.task.files[0].path as string;
    const imagePath = created.task.images[0].path as string;
    await call('DELETE', `/api/scheduled-tasks/${created.task.id}`);
    await expect(fs.access(filePath)).rejects.toThrow();
    await expect(fs.access(imagePath)).rejects.toThrow();
    await expect(fs.access(path.join(dir, 'task-files', created.task.id))).rejects.toThrow();
  });

  it('removes copied attachments when the task cannot be stored', async () => {
    await fakeUpload('f', 'f.txt');
    vi.spyOn(store, 'create').mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('POST', '/api/scheduled-tasks', { ...validInput, files: [{ uploadId: 'f' }] });
    expect(res.status).toBe(500);
    expect(await fs.readdir(path.join(dir, 'task-files')).catch(() => [])).toEqual([]);
    vi.restoreAllMocks();
  });
});
