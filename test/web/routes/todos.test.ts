import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TodoStore } from '../../../src/session/todo-store.js';
import { createTodosRouter } from '../../../src/web/routes/todos.js';
import { decodeTodoPng } from '../../../src/web/todo-image.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('待办路由', () => {
  let dir: string;
  let server: Server;
  let base: string;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  });

  async function start() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-todo-api-'));
    const store = new TodoStore(path.join(dir, 'todos.json'), path.join(dir, 'files'));
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api/todos', createTodosRouter(store));
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  }

  async function call(method: string, url: string, body?: unknown) {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const isPng = (res.headers.get('content-type') || '').includes('image/png');
    if (isPng) return { status: res.status, png: Buffer.from(await res.arrayBuffer()), body: null };
    const text = await res.text();
    return {
      status: res.status,
      png: null,
      body: text ? JSON.parse(text) as Record<string, any> : null,
    };
  }

  it('从 PNG 头读出宽高', () => {
    const decoded = decodeTodoPng(`data:image/png;base64,${PNG_1x1.toString('base64')}`);
    expect(decoded?.width).toBe(1);
    expect(decoded?.height).toBe(1);
    expect(decodeTodoPng(undefined)).toBeNull();
    expect(() => decodeTodoPng('data:image/jpeg;base64,aaaa')).toThrow('截图格式无效');
  });

  it('记下文字或只有截图，勾完、删除，图片能取回', async () => {
    await start();
    const empty = await call('POST', '/api/todos', { text: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body?.error).toBe('待办内容不能为空');

    const created = await call('POST', '/api/todos', { text: '  回头看这个报错  ' });
    expect(created.status).toBe(200);
    expect(created.body?.todo.text).toBe('回头看这个报错');
    expect(created.body?.todo.image).toBeNull();

    const shot = await call('POST', '/api/todos', {
      text: '',
      image: `data:image/png;base64,${PNG_1x1.toString('base64')}`,
    });
    expect(shot.status).toBe(200);
    expect(shot.body?.todo.text).toBe('');
    expect(shot.body?.todo.image).toMatchObject({ width: 1, height: 1 });
    const imageUrl = shot.body?.todo.image.url as string;

    const listed = await call('GET', '/api/todos');
    expect(listed.body?.todos.map((item: { text: string }) => item.text)).toEqual(['', '回头看这个报错']);

    const png = await call('GET', imageUrl);
    expect(png.status).toBe(200);
    expect(png.png).toEqual(PNG_1x1);

    const done = await call('POST', `${imageUrl.replace(/\/image$/, '')}/done`, { done: true });
    expect(done.status).toBe(200);
    expect(done.body?.todo.doneAt).toEqual(expect.any(Number));

    const removed = await call('DELETE', imageUrl.replace(/\/image$/, ''));
    expect(removed.status).toBe(200);
    const after = await call('GET', imageUrl);
    expect(after.status).toBe(404);
  });
});
