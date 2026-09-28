import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, startServer } from '../../src/web/server.js';
import { createConfigRouter } from '../../src/web/routes/config.js';
import type { Server } from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

describe('PATCH /api/config/sub-agents', () => {
  let server: Server | null = null;
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sub-agents-route-'));
    configPath = path.join(tempDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ providers: [] }, null, 2));
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function startTestServer(): Promise<number> {
    const app = await createServer({
      routes: [{
        path: '/api/config',
        router: createConfigRouter({ configPath }),
      }],
    });
    server = await startServer(app, 0);
    return getPort(server);
  }

  it('缺失时开启，关闭后保存模型配置仍保持关闭', async () => {
    const port = await startTestServer();
    const before = await fetch(`http://127.0.0.1:${port}/api/config`);
    expect((await before.json()).enableSubAgents).toBe(true);

    const patched = await fetch(`http://127.0.0.1:${port}/api/config/sub-agents`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableSubAgents: false }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).enableSubAgents).toBe(false);

    const saved = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providers: [{
          id: 'default',
          apiUrl: 'https://api.deepseek.com',
          apiKey: 'sk-test1234567890abcdef',
          modelName: 'deepseek-chat',
          parameters: { temperature: 0.7 },
          isDefault: true,
        }],
      }),
    });
    expect(saved.ok).toBe(true);

    const after = await fetch(`http://127.0.0.1:${port}/api/config`);
    expect((await after.json()).enableSubAgents).toBe(false);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf-8')) as { enableSubAgents?: boolean };
    expect(raw.enableSubAgents).toBe(false);
  });

  it('非 boolean 返回 400', async () => {
    const port = await startTestServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/config/sub-agents`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableSubAgents: 'no' }),
    });
    expect(res.status).toBe(400);
  });
});
