/**
 * 多会话隔离与删除清理：
 *  - session-notes.md 路径按 sessionId 隔离
 *  - DELETE /:id 同时清理 .session-notes.md / .checkpoint.json 等文件族
 *  - 旧全局 session-notes.md 迁移到 default.session-notes.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  initSessionMemoryState,
  sessionNotesPath,
} from '../../src/memory/file-memory/session-memory.js';

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true).catch(() => false);
}

describe('session-notes path is per-session', () => {
  it('initSessionMemoryState writes notes under {sessionId}.session-notes.md', () => {
    const sessA = initSessionMemoryState('/tmp/sessions', 'sess-a');
    const sessB = initSessionMemoryState('/tmp/sessions', 'sess-b');
    expect(sessA.notesPath).toBe(path.join('/tmp/sessions', 'sess-a.session-notes.md'));
    expect(sessB.notesPath).toBe(path.join('/tmp/sessions', 'sess-b.session-notes.md'));
    expect(sessA.notesPath).not.toBe(sessB.notesPath);
  });

  it('sessionNotesPath helper matches', () => {
    expect(sessionNotesPath('/tmp/sessions', 'x')).toBe(
      path.join('/tmp/sessions', 'x.session-notes.md'),
    );
  });

  it('falls back to default when sessionId omitted', () => {
    const s = initSessionMemoryState('/tmp/sessions');
    expect(s.notesPath).toBe(path.join('/tmp/sessions', 'default.session-notes.md'));
  });
});

describe('Sessions REST: delete + migrate (multi-session isolation)', () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  const prev = process.env.ICE_SESSIONS_DIR;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-iso-'));
    process.env.ICE_SESSIONS_DIR = tempDir;
    vi.resetModules();
    const { createSessionsRouter, registerSessionCleanupHook } = await import(
      '../../src/web/routes/sessions.js'
    );
    registerSessionCleanupHook(null);

    const app = express();
    app.use(express.json());
    app.use('/api/sessions', createSessionsRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${getPort(server)}/api/sessions`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (prev === undefined) delete process.env.ICE_SESSIONS_DIR;
    else process.env.ICE_SESSIONS_DIR = prev;
  });

  it('migrates legacy global session-notes.md to default.session-notes.md on first GET', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const legacy = path.join(tempDir, 'session-notes.md');
    const target = path.join(tempDir, 'default.session-notes.md');
    await fs.writeFile(legacy, '# legacy notes', 'utf-8');

    const res = await fetch(`${baseUrl}/`);
    expect(res.ok).toBe(true);

    expect(await exists(legacy)).toBe(false);
    expect(await exists(target)).toBe(true);
    const moved = await fs.readFile(target, 'utf-8');
    expect(moved).toBe('# legacy notes');
  });

  it('DELETE /:id removes full file family including .session-notes.md', async () => {
    const sessionId = 'sess-del';
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'index.json'),
      JSON.stringify([
        { id: sessionId, title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 },
      ]),
      'utf-8',
    );
    const family = [
      `${sessionId}.json`,
      `${sessionId}.structured.json`,
      `${sessionId}.checkpoint.json`,
      `${sessionId}.workspace.json`,
      `${sessionId}.session-notes.md`,
    ];
    for (const name of family) {
      await fs.writeFile(path.join(tempDir, name), name, 'utf-8');
    }

    const res = await fetch(`${baseUrl}/${sessionId}`, { method: 'DELETE' });
    expect(res.ok).toBe(true);

    for (const name of family) {
      expect(await exists(path.join(tempDir, name))).toBe(false);
    }
  });

  it('DELETE invokes registered runtime-cache cleanup hook', async () => {
    const sessionId = 'sess-hook';
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'index.json'),
      JSON.stringify([
        { id: sessionId, title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 },
      ]),
      'utf-8',
    );
    await fs.writeFile(path.join(tempDir, `${sessionId}.json`), '[]', 'utf-8');

    const { registerSessionCleanupHook } = await import('../../src/web/routes/sessions.js');
    const called: string[] = [];
    registerSessionCleanupHook((id) => { called.push(id); });

    const res = await fetch(`${baseUrl}/${sessionId}`, { method: 'DELETE' });
    expect(res.ok).toBe(true);
    expect(called).toEqual([sessionId]);
  });

  it('GET /:id/plan reads {sessionId}.session-notes.md (not the global file)', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const sessionId = 'sess-plan';
    await fs.writeFile(
      path.join(tempDir, 'index.json'),
      JSON.stringify([
        { id: sessionId, title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 },
      ]),
      'utf-8',
    );
    const planFixture = {
      version: 1,
      planId: 'plan-1',
      goal: 'isolation-test',
      intent: 'inspect',
      steps: [{
        id: 's1',
        title: 'hello',
        phase: 'intent',
        requiresTool: false,
        status: 'pending',
      }],
      progress: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    await fs.writeFile(
      path.join(tempDir, `${sessionId}.session-notes.md`),
      '# notes\n\n```icecoder-plan\n' + JSON.stringify(planFixture) + '\n```\n',
      'utf-8',
    );

    const res = await fetch(`${baseUrl}/${sessionId}/plan`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { plan: { steps: { title: string }[] } | null };
    expect(body.plan).toBeTruthy();
    expect(body.plan?.steps[0]?.title).toBe('hello');
  });

  it('GET /:id/plan does NOT cross-leak from other session notes', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    const a = 'sess-a';
    const b = 'sess-b';
    await fs.writeFile(
      path.join(tempDir, 'index.json'),
      JSON.stringify([
        { id: a, title: 'A', createdAt: 1, updatedAt: 1, messageCount: 0 },
        { id: b, title: 'B', createdAt: 1, updatedAt: 1, messageCount: 0 },
      ]),
      'utf-8',
    );
    const planA = {
      version: 1, planId: 'pa', goal: 'A', intent: 'inspect',
      steps: [{ id: 's1', title: 'plan-for-A', phase: 'intent', requiresTool: false, status: 'pending' }],
      progress: 0, createdAt: 1, updatedAt: 1,
    };
    await fs.writeFile(
      path.join(tempDir, `${a}.session-notes.md`),
      '```icecoder-plan\n' + JSON.stringify(planA) + '\n```\n',
      'utf-8',
    );

    const resB = await fetch(`${baseUrl}/${b}/plan`);
    expect(resB.ok).toBe(true);
    const bodyB = await resB.json() as { plan: unknown };
    expect(bodyB.plan).toBeNull();

    const resA = await fetch(`${baseUrl}/${a}/plan`);
    const bodyA = await resA.json() as { plan: { steps: { title: string }[] } };
    expect(bodyA.plan?.steps[0]?.title).toBe('plan-for-A');
  });
});
