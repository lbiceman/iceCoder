import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, startServer } from '../../src/web/server.js';
import { createConfigRouter } from '../../src/web/routes/config.js';
import type { Server } from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'node:url';

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

describe('PATCH /api/config/use-windows', () => {
  let server: Server | null = null;
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'use-windows-route-'));
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

  it('缺失时关闭，打开后保存模型配置仍保持打开', async () => {
    const port = await startTestServer();
    const before = await fetch(`http://127.0.0.1:${port}/api/config`);
    const beforeBody = await before.json();
    expect(beforeBody.useWindows).toBe(false);
    expect(beforeBody.useWindowsSupported).toBe(process.platform === 'win32');

    const patched = await fetch(`http://127.0.0.1:${port}/api/config/use-windows`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useWindows: true }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json()).useWindows).toBe(true);

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
    expect((await after.json()).useWindows).toBe(true);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf-8')) as { useWindows?: boolean };
    expect(raw.useWindows).toBe(true);
  });

  it('非 boolean 返回 400', async () => {
    const port = await startTestServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/config/use-windows`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useWindows: 'yes' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('settings switch markup', () => {
  it('设置页有 useWindows 开关', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/public/js/config-page.ts'),
      'utf-8',
    );
    expect(src).toContain('settings-use-windows-input');
    expect(src).toContain('/api/config/use-windows');
    expect(src).toContain('useWindows');
    expect(src).toContain('实验性');
    expect(src).toContain('取决于模型能力');
  });
});
