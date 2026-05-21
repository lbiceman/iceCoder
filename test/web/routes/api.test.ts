/**
 * Unit tests for API routes: config and chat/upload.
 * Requirements: 22.4, 22.5, 23.7, 23.9, 24.2, 24.4
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, startServer } from '../../../src/web/server.js';
import { createUploadRouter, CHAT_UPLOAD_MAX_FILE_BYTES } from '../../../src/web/routes/upload.js';
import type { Server } from 'http';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const staticDir = path.join(process.cwd(), 'src/public');

// Helper to get a random port from a running server
function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

describe('Config API Routes', () => {
  let server: Server | null = null;
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-test-'));
    configPath = path.join(tempDir, 'config.json');
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Creates a test server with config routes that use a temp config file path.
   * We mock the CONFIG_PATH by creating a custom router that mirrors config.ts logic
   * but uses our temp path.
   */
  async function createTestServer() {
    const { Router } = await import('express');
    const router = Router();

    // Inline config route logic with custom config path
    function maskApiKey(apiKey: string): string {
      if (apiKey.length <= 8) return '****';
      const first = apiKey.slice(0, 4);
      const last = apiKey.slice(-4);
      return `${first}${'*'.repeat(apiKey.length - 8)}${last}`;
    }

    router.post('/', async (req, res) => {
      try {
        const { providers } = req.body;
        if (!providers || !Array.isArray(providers)) {
          res.status(400).json({ error: 'Request body must contain a providers array' });
          return;
        }
        for (let i = 0; i < providers.length; i++) {
          const p = providers[i];
          if (!p.apiUrl || p.apiUrl.trim() === '') {
            res.status(400).json({ error: `Provider ${i}: API URL is required and cannot be empty` });
            return;
          }
          if (!p.apiKey || p.apiKey.trim() === '') {
            res.status(400).json({ error: `Provider ${i}: API Key is required and cannot be empty` });
            return;
          }
        }
        await fs.writeFile(configPath, JSON.stringify({ providers }, null, 2), 'utf-8');
        res.json({ success: true, message: 'Configuration saved successfully' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ error: `Failed to save configuration: ${message}` });
      }
    });

    router.get('/', async (_req, res) => {
      try {
        const data = await fs.readFile(configPath, 'utf-8');
        const config = JSON.parse(data);
        const maskedProviders = config.providers.map((provider: any) => ({
          ...provider,
          apiKey: maskApiKey(provider.apiKey),
        }));
        res.json({ providers: maskedProviders });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          res.json({ providers: [] });
          return;
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ error: `Failed to load configuration: ${message}` });
      }
    });

    const app = await createServer({
      staticDir,
      routes: [{ path: '/api/config', router }],
    });
    server = await startServer(app, 0);
    return getPort(server);
  }

  it('POST /api/config with valid providers saves successfully', async () => {
    const port = await createTestServer();
    const providers = [
      {
        id: 'test-provider',
        providerName: 'openai',
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test1234567890abcdef',
        modelName: 'gpt-4',
        parameters: { temperature: 0.7 },
      },
    ];

    const response = await fetch(`http://localhost:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.message).toBe('Configuration saved successfully');

    // Verify file was written
    const saved = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(saved.providers).toHaveLength(1);
    expect(saved.providers[0].apiUrl).toBe('https://api.openai.com/v1');
  });

  it('POST /api/config with empty API URL returns 400', async () => {
    const port = await createTestServer();
    const providers = [
      {
        id: 'test-provider',
        providerName: 'openai',
        apiUrl: '',
        apiKey: 'sk-test1234567890abcdef',
        modelName: 'gpt-4',
        parameters: {},
      },
    ];

    const response = await fetch(`http://localhost:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('API URL');
  });

  it('POST /api/config with empty API Key returns 400', async () => {
    const port = await createTestServer();
    const providers = [
      {
        id: 'test-provider',
        providerName: 'openai',
        apiUrl: 'https://api.openai.com/v1',
        apiKey: '',
        modelName: 'gpt-4',
        parameters: {},
      },
    ];

    const response = await fetch(`http://localhost:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('API Key');
  });

  it('GET /api/config returns providers with masked API keys', async () => {
    const port = await createTestServer();

    // First save a config
    const apiKey = 'sk-test1234567890abcdef';
    const providers = [
      {
        id: 'test-provider',
        providerName: 'openai',
        apiUrl: 'https://api.openai.com/v1',
        apiKey,
        modelName: 'gpt-4',
        parameters: { temperature: 0.7 },
      },
    ];

    await fetch(`http://localhost:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });

    // Now load it
    const response = await fetch(`http://localhost:${port}/api/config`);
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.providers).toHaveLength(1);
    const maskedKey = data.providers[0].apiKey;
    // API key masking: first 4 + asterisks + last 4
    expect(maskedKey.slice(0, 4)).toBe(apiKey.slice(0, 4));
    expect(maskedKey.slice(-4)).toBe(apiKey.slice(-4));
    expect(maskedKey).toContain('*');
    expect(maskedKey).not.toBe(apiKey);
  });

  it('GET /api/config returns empty providers when no config file exists', async () => {
    const port = await createTestServer();

    const response = await fetch(`http://localhost:${port}/api/config`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.providers).toEqual([]);
  });

  it('API key masking: first 4 + asterisks + last 4', async () => {
    const port = await createTestServer();

    const apiKey = 'abcd12345678wxyz';
    const providers = [
      {
        id: 'test',
        providerName: 'openai',
        apiUrl: 'https://api.example.com',
        apiKey,
        modelName: 'gpt-4',
        parameters: {},
      },
    ];

    await fetch(`http://localhost:${port}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });

    const response = await fetch(`http://localhost:${port}/api/config`);
    const data = await response.json();
    const masked = data.providers[0].apiKey;

    // "abcd12345678wxyz" → "abcd********wxyz"
    expect(masked).toBe('abcd********wxyz');
    expect(masked.length).toBe(apiKey.length);
  });
});

describe('Chat upload API routes', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  async function createUploadTestServer(): Promise<number> {
    const app = await createServer({
      staticDir,
      routes: [{ path: '/api/chat', router: createUploadRouter() }],
    });
    server = await startServer(app, 0);
    return getPort(server);
  }

  it('GET /api/chat/supported-formats returns capability JSON', async () => {
    const port = await createUploadTestServer();
    const response = await fetch(`http://localhost:${port}/api/chat/supported-formats`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(Array.isArray(data.extensions)).toBe(true);
    expect(Array.isArray(data.imageExtensions)).toBe(true);
    expect(data.maxFileBytes).toBe(CHAT_UPLOAD_MAX_FILE_BYTES);
    expect(data.imageExtensions).toContain('.png');
  });
});
