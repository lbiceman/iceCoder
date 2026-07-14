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

describe('setup gate + config readiness API', () => {
  let server: Server | null = null;
  let tempDir: string;
  let configPath: string;
  let setupRequired = true;

  // 隔离候选环境变量，避免本机 export 的 Key 影响占位符断言
  const MANAGED_ENV_KEYS = ['DEFAULT_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const k of MANAGED_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-gate-'));
    configPath = path.join(tempDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      providers: [{
        id: 'default',
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-your-api-key-here',
        modelName: 'gpt-4o',
        parameters: { temperature: 0.7 },
        isDefault: true,
      }],
    }, null, 2));
    setupRequired = true;
  });

  afterEach(async () => {
    for (const k of MANAGED_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  async function startTestServer() {
    const app = await createServer({
      setupGate: () => setupRequired,
      routes: [{
        path: '/api/config',
        router: createConfigRouter({
          configPath,
          setSetupRequired: (required) => { setupRequired = required; },
        }),
      }],
    });
    server = await startServer(app, 0);
    return getPort(server);
  }

  it('GET /api/config reports setupRequired for placeholder key', async () => {
    const port = await startTestServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/config`);
    const body = await res.json();
    expect(body.setupRequired).toBe(true);
  });

  it('blocks non-config APIs while setup is required', async () => {
    const port = await startTestServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.setupRequired).toBe(true);
  });

  it('treats env-provided api key as ready and marks source in GET', async () => {
    // 配置文件只有占位符，但环境变量提供 Key
    await fs.writeFile(configPath, JSON.stringify({
      providers: [{
        id: 'default',
        apiUrl: 'https://api.deepseek.com',
        apiKey: 'sk-your-api-key-here',
        modelName: 'deepseek-chat',
        parameters: { temperature: 0.7 },
        isDefault: true,
      }],
    }, null, 2));
    const prev = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-env-abcdef1234567890';
    try {
      const port = await startTestServer();
      const res = await fetch(`http://127.0.0.1:${port}/api/config`);
      const body = await res.json();
      expect(body.setupRequired).toBe(false);
      expect(body.providers[0].apiKeySource).toBe('env');
      expect(body.providers[0].apiKeyEnvVar).toBe('DEEPSEEK_API_KEY');
      // env 来源不回传密钥内容
      expect(body.providers[0].apiKey).toBe('');
    } finally {
      if (prev === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = prev;
    }
  });

  it('clears setupRequired after saving a valid config', async () => {
    const port = await startTestServer();
    const saveRes = await fetch(`http://127.0.0.1:${port}/api/config`, {
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
    const saveBody = await saveRes.json();
    expect(saveRes.ok).toBe(true);
    expect(saveBody.setupComplete).toBe(true);

    const getRes = await fetch(`http://127.0.0.1:${port}/api/config`);
    const getBody = await getRes.json();
    expect(getBody.setupRequired).toBe(false);
  });
});
