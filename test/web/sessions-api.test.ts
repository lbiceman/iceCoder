/**
 * 多会话 REST API：index、:id 动态路径、default 引导
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

describe('Sessions API (multi-session)', () => {
  let tempDir: string;
  let server: Server;
  let baseUrl: string;
  const prevSessionsDir = process.env.ICE_SESSIONS_DIR;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-api-'));
    process.env.ICE_SESSIONS_DIR = tempDir;
    vi.resetModules();
    const { createSessionsRouter } = await import('../../src/web/routes/sessions.js');

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
    if (prevSessionsDir === undefined) {
      delete process.env.ICE_SESSIONS_DIR;
    } else {
      process.env.ICE_SESSIONS_DIR = prevSessionsDir;
    }
  });

  it('GET / ensures default entry when only default.json exists', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'default.json'),
      JSON.stringify([{ role: 'user', content: 'legacy' }]),
      'utf-8',
    );

    const res = await fetch(`${baseUrl}/`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { sessions: { id: string; title: string }[] };
    const def = body.sessions.find((s) => s.id === 'default');
    expect(def).toBeTruthy();
    expect(def?.title).toBe('legacy');

    const indexRaw = await fs.readFile(path.join(tempDir, 'index.json'), 'utf-8');
    const index = JSON.parse(indexRaw) as { id: string; title: string }[];
    expect(index.find((s) => s.id === 'default')?.title).toBe('legacy');
  });

  it('GET /:id and PUT /:id use req.params.id not hardcoded default', async () => {
    const sessionId = 'abc12345';
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, `${sessionId}.json`), '[]', 'utf-8');

    const putRes = await fetch(`${baseUrl}/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'for-b' }],
      }),
    });
    expect(putRes.ok).toBe(true);

    const getRes = await fetch(`${baseUrl}/${sessionId}`);
    const getBody = await getRes.json() as { messages: { content: string }[] };
    expect(getBody.messages[0].content).toBe('for-b');

    const defaultRes = await fetch(`${baseUrl}/default`);
    const defaultBody = await defaultRes.json() as { messages: unknown[] };
    expect(defaultBody.messages).toEqual([]);
  });

  it('POST / creates session and updates index', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '测试会话' }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json() as { success: boolean; session: { id: string; title: string } };
    expect(body.success).toBe(true);
    expect(body.session.title).toBe('测试会话');

    const listRes = await fetch(`${baseUrl}/`);
    const list = await listRes.json() as { sessions: { id: string }[] };
    expect(list.sessions.some((s) => s.id === body.session.id)).toBe(true);

    const fileExists = await fs
      .access(path.join(tempDir, `${body.session.id}.json`))
      .then(() => true)
      .catch(() => false);
    expect(fileExists).toBe(true);
  });

  it('DELETE /default removes default session from index and disk', async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'default.json'), '[]', 'utf-8');
    await fs.writeFile(
      path.join(tempDir, 'index.json'),
      JSON.stringify([{
        id: 'default',
        title: '默认会话',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 0,
      }]),
      'utf-8',
    );

    const res = await fetch(`${baseUrl}/default`, { method: 'DELETE' });
    expect(res.ok).toBe(true);

    const index = JSON.parse(await fs.readFile(path.join(tempDir, 'index.json'), 'utf-8')) as { id: string }[];
    expect(index.some((s) => s.id === 'default')).toBe(false);

    const defaultFileExists = await fs
      .access(path.join(tempDir, 'default.json'))
      .then(() => true)
      .catch(() => false);
    expect(defaultFileExists).toBe(false);
  });
});
