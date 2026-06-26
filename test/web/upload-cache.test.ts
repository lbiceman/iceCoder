/**
 * 上传缓存治理测试（P1-12）。
 *
 * 覆盖：FIFO 上限淘汰 + 淘汰时删除临时文件 + 出错返回正确 HTTP 状态码。
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, startServer } from '../../src/web/server.js';
import {
  createUploadRouter,
  getUploadedFile,
  purgeAllUploadedFiles,
} from '../../src/web/routes/upload.js';
import type { Server } from 'http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const staticDir = path.join(process.cwd(), 'src/public');

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

let server: Server | null = null;
let prevMax: string | undefined;

beforeEach(() => {
  prevMax = process.env.ICE_UPLOAD_CACHE_MAX;
  purgeAllUploadedFiles();
});

afterEach(async () => {
  purgeAllUploadedFiles();
  if (prevMax === undefined) delete process.env.ICE_UPLOAD_CACHE_MAX;
  else process.env.ICE_UPLOAD_CACHE_MAX = prevMax;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function createUploadServer(): Promise<number> {
  const app = await createServer({
    staticDir,
    routes: [{ path: '/api/chat', router: createUploadRouter() }],
  });
  server = await startServer(app, 0);
  return getPort(server);
}

async function uploadFile(port: number, name: string, content: string): Promise<Response> {
  const fd = new FormData();
  fd.append('file', new Blob([content]), name);
  return fetch(`http://localhost:${port}/api/chat/upload`, { method: 'POST', body: fd });
}

describe('chat upload cache governance', () => {
  it('evicts oldest entry past the cap and deletes its temp file', async () => {
    process.env.ICE_UPLOAD_CACHE_MAX = '2';
    const port = await createUploadServer();

    const r1 = await uploadFile(port, 'a.txt', 'first');
    const { fileId: id1 } = await r1.json();
    const meta1 = getUploadedFile(id1);
    expect(meta1).toBeDefined();
    const tmpPath1 = meta1!.filePath;
    await expect(fs.access(tmpPath1)).resolves.toBeUndefined();

    const r2 = await uploadFile(port, 'b.txt', 'second');
    const { fileId: id2 } = await r2.json();
    const r3 = await uploadFile(port, 'c.txt', 'third');
    const { fileId: id3 } = await r3.json();

    // 超过上限 2，最旧的 id1 被淘汰
    expect(getUploadedFile(id1)).toBeUndefined();
    expect(getUploadedFile(id2)).toBeDefined();
    expect(getUploadedFile(id3)).toBeDefined();

    // 被淘汰条目的临时文件应被删除
    await expect(fs.access(tmpPath1)).rejects.toBeTruthy();
  });

  it('returns 400 when no file is provided', async () => {
    const port = await createUploadServer();
    const fd = new FormData();
    const res = await fetch(`http://localhost:${port}/api/chat/upload`, { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });
});
