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

  beforeEach(async () => {
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
