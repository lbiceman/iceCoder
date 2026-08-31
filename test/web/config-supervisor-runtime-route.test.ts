import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, startServer } from '../../src/web/server.js';
import { createConfigRouter } from '../../src/web/routes/config.js';
import { validateSupervisorSettingsDocument } from '../../src/config/supervisor-settings-io.js';
import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import type { Server } from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

describe('validateSupervisorSettingsDocument', () => {
  it('接受完整默认配置', () => {
    expect(validateSupervisorSettingsDocument(defaultSupervisorConfig())).toBeNull();
  });

  it('拒绝未知顶层字段', () => {
    expect(validateSupervisorSettingsDocument({
      ...defaultSupervisorConfig(),
      unknownField: 1,
    })).toMatch(/未知字段/);
  });

  it('拒绝非法 mode', () => {
    expect(validateSupervisorSettingsDocument({
      ...defaultSupervisorConfig(),
      mode: 'loose',
    })).toMatch(/mode/);
  });
});

describe('GET/PUT /api/config/supervisor-runtime', () => {
  let server: Server | null = null;
  let tempDir: string;
  let configPath: string;
  let supervisorPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-runtime-'));
    configPath = path.join(tempDir, 'config.json');
    supervisorPath = path.join(tempDir, 'supervisor-config.json');
    await fs.writeFile(configPath, JSON.stringify({ providers: [], supervisorMode: 'adaptive' }, null, 2));
    await fs.writeFile(supervisorPath, JSON.stringify({
      mode: 'adaptive',
      executionMode: { writeTargetsEnterThreshold: 3 },
    }, null, 2));
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
      setupGate: () => false,
      routes: [{
        path: '/api/config',
        router: createConfigRouter({
          configPath,
          supervisorConfigPath: supervisorPath,
        }),
      }],
    });
    server = await startServer(app, 0);
    return getPort(server);
  }

  it('GET 用文件值覆盖默认（writeTargetsEnterThreshold=3）', async () => {
    const port = await startTestServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/config/supervisor-runtime`);
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; config: { executionMode: { writeTargetsEnterThreshold: number } } };
    expect(body.success).toBe(true);
    expect(body.config.executionMode.writeTargetsEnterThreshold).toBe(3);
  });

  it('PUT 写入文件，不改 config.json 的 supervisorMode', async () => {
    const port = await startTestServer();
    const loaded = await fetch(`http://127.0.0.1:${port}/api/config/supervisor-runtime`).then(r => r.json()) as {
      config: Record<string, unknown>;
    };
    const next = {
      ...loaded.config,
      mode: 'off',
      executionMode: {
        ...(loaded.config.executionMode as object),
        writeTargetsEnterThreshold: 4,
      },
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/config/supervisor-runtime`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: next }),
    });
    expect(res.status).toBe(200);
    const saved = JSON.parse(await fs.readFile(supervisorPath, 'utf-8')) as {
      mode: string;
      executionMode: { writeTargetsEnterThreshold: number };
    };
    expect(saved.mode).toBe('off');
    expect(saved.executionMode.writeTargetsEnterThreshold).toBe(4);
    const main = JSON.parse(await fs.readFile(configPath, 'utf-8')) as { supervisorMode: string };
    expect(main.supervisorMode).toBe('adaptive');
  });

  it('PUT 未知字段返回 400', async () => {
    const port = await startTestServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/config/supervisor-runtime`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...defaultSupervisorConfig(), extra: true } }),
    });
    expect(res.status).toBe(400);
  });
});
