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

describe('scheduled tasks router', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let store: ScheduledTaskStore;
  let now: number;
  const scheduler = { reschedule: vi.fn(async () => {}), runNow: vi.fn(async (_id: string) => {}) };
  const createSession = vi.fn(async (_title: string) => ({ id: 'sess-1' }));

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
    const app = express();
    app.use(express.json());
    app.use('/api/scheduled-tasks', createScheduledTasksRouter({ store, scheduler, createSession }));
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

  it('returns 500 when session creation fails', async () => {
    createSession.mockRejectedValueOnce(new Error('disk full'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('POST', '/api/scheduled-tasks', validInput);
    expect(res.status).toBe(500);
    expect(await store.list()).toHaveLength(0);
  });
});
