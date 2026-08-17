import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, startServer } from '../../src/web/server.js';
import { createConfigRouter } from '../../src/web/routes/config.js';
import type { Server } from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { USER_DATA_DIR } from '../../src/cli/paths.js';

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

describe('GET/PUT /api/config/data-directory', () => {
  let server: Server | null = null;
  let identityDir: string;
  let dataDir: string;
  const envBackup: Record<string, string | undefined> = {};
  const keys = ['NODE_ENV', 'ICE_SHELL_IDENTITY_DIR', 'ICE_DATA_DIR', 'ICE_DEFAULT_WORK_DIR'];

  beforeEach(async () => {
    for (const key of keys) {
      envBackup[key] = process.env[key];
    }
    identityDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-dir-id-'));
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'data-dir-data-'));
    process.env.ICE_SHELL_IDENTITY_DIR = identityDir;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    for (const key of keys) {
      if (envBackup[key] === undefined) delete process.env[key];
      else process.env[key] = envBackup[key];
    }
    await fs.rm(identityDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  async function listen(): Promise<number> {
    const app = await createServer({
      staticDir: path.join(process.cwd(), 'src/public'),
      routes: [{ path: '/api/config', router: createConfigRouter() }],
    });
    server = await startServer(app, 0);
    return getPort(server);
  }

  it('GET 返回当前 dataDir 与 canPersist', async () => {
    const port = await listen();
    const res = await fetch(`http://127.0.0.1:${port}/api/config/data-directory`);
    expect(res.status).toBe(200);
    const body = await res.json() as { dataDir: string; defaultDataDir: string; canPersist: boolean };
    expect(body.defaultDataDir).toBe(USER_DATA_DIR);
    expect(typeof body.dataDir).toBe('string');
    expect(typeof body.canPersist).toBe('boolean');
  });

  it('生产模式 PUT 绝对路径后 GET 能读到 persistedDataDir', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ICE_DATA_DIR;
    const port = await listen();
    const put = await fetch(`http://127.0.0.1:${port}/api/config/data-directory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataDir }),
    });
    expect(put.status).toBe(200);
    const saved = await put.json() as { persistedDataDir: string; restartRequired: boolean };
    expect(saved.persistedDataDir).toBe(path.resolve(dataDir));
    expect(saved.restartRequired).toBe(true);

    const get = await fetch(`http://127.0.0.1:${port}/api/config/data-directory`);
    const body = await get.json() as { persistedDataDir: string | null };
    expect(body.persistedDataDir).toBe(path.resolve(dataDir));
  });

  it('相对路径 PUT 返回 400', async () => {
    process.env.NODE_ENV = 'production';
    const port = await listen();
    const put = await fetch(`http://127.0.0.1:${port}/api/config/data-directory`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataDir: 'relative' }),
    });
    expect(put.status).toBe(400);
  });
});
