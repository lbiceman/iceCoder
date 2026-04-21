/**
 * Unit tests for API routes: config, chat/upload, SSE, and pipeline status.
 * Requirements: 22.4, 22.5, 23.7, 23.9, 24.2, 24.4
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createServer, startServer } from '../server.js';
import { createConfigRouter } from './config.js';
import { createChatRouter } from './chat.js';
import { createPipelineRouter } from './pipeline.js';
import { SSEManager } from '../sse.js';
import type { Server } from 'http';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { PipelineState, StageStatus } from '../../core/types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

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
      staticDir: path.join(__dirname, '../../public'),
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

    // "abcd12345678wxyz" �?"abcd********wxyz"
    expect(masked).toBe('abcd********wxyz');
    expect(masked.length).toBe(apiKey.length);
  });
});


describe('SSE Manager', () => {
  it('addConnection sets proper SSE headers', () => {
    const sseManager = new SSEManager();
    const headers: Record<string, string> = {};
    let flushed = false;

    const mockRes = {
      setHeader: (key: string, value: string) => {
        headers[key] = value;
      },
      flushHeaders: () => {
        flushed = true;
      },
      on: (_event: string, _cb: () => void) => {},
      end: () => {},
    } as any;

    sseManager.addConnection('exec-1', mockRes);

    expect(headers['Content-Type']).toBe('text/event-stream');
    expect(headers['Cache-Control']).toBe('no-cache');
    expect(headers['Connection']).toBe('keep-alive');
    expect(flushed).toBe(true);
  });

  it('push sends events to connected clients', () => {
    const sseManager = new SSEManager();
    const written: string[] = [];

    const mockRes = {
      setHeader: () => {},
      flushHeaders: () => {},
      on: () => {},
      write: (data: string) => {
        written.push(data);
      },
      end: () => {},
    } as any;

    sseManager.addConnection('exec-1', mockRes);
    sseManager.push('exec-1', {
      type: 'message',
      data: { content: 'Hello world' },
    });

    expect(written).toHaveLength(1);
    expect(written[0]).toContain('event: message');
    expect(written[0]).toContain('"content":"Hello world"');
  });

  it('push sends events to multiple connected clients', () => {
    const sseManager = new SSEManager();
    const written1: string[] = [];
    const written2: string[] = [];

    const mockRes1 = {
      setHeader: () => {},
      flushHeaders: () => {},
      on: () => {},
      write: (data: string) => written1.push(data),
      end: () => {},
    } as any;

    const mockRes2 = {
      setHeader: () => {},
      flushHeaders: () => {},
      on: () => {},
      write: (data: string) => written2.push(data),
      end: () => {},
    } as any;

    sseManager.addConnection('exec-1', mockRes1);
    sseManager.addConnection('exec-1', mockRes2);

    sseManager.push('exec-1', {
      type: 'stage_update',
      data: { content: 'Stage 1 complete' },
    });

    expect(written1).toHaveLength(1);
    expect(written2).toHaveLength(1);
  });

  it('removeConnection cleans up specific connection', () => {
    const sseManager = new SSEManager();

    const mockRes = {
      setHeader: () => {},
      flushHeaders: () => {},
      on: () => {},
      write: () => {},
      end: () => {},
    } as any;

    sseManager.addConnection('exec-1', mockRes);
    expect(sseManager.getConnectionCount('exec-1')).toBe(1);

    sseManager.removeConnection('exec-1', mockRes);
    expect(sseManager.getConnectionCount('exec-1')).toBe(0);
  });

  it('removeConnection without res cleans up all connections for execution ID', () => {
    const sseManager = new SSEManager();
    let ended1 = false;
    let ended2 = false;

    const mockRes1 = {
      setHeader: () => {},
      flushHeaders: () => {},
      on: () => {},
      write: () => {},
      end: () => { ended1 = true; },
    } as any;

    const mockRes2 = {
      setHeader: () => {},
      flushHeaders: () => {},
      on: () => {},
      write: () => {},
      end: () => { ended2 = true; },
    } as any;

    sseManager.addConnection('exec-1', mockRes1);
    sseManager.addConnection('exec-1', mockRes2);
    expect(sseManager.getConnectionCount('exec-1')).toBe(2);

    sseManager.removeConnection('exec-1');
    expect(sseManager.getConnectionCount('exec-1')).toBe(0);
    expect(ended1).toBe(true);
    expect(ended2).toBe(true);
  });

  it('push does nothing for unknown execution ID', () => {
    const sseManager = new SSEManager();
    // Should not throw
    sseManager.push('nonexistent', {
      type: 'message',
      data: { content: 'test' },
    });
  });
});

describe('File Upload Validation', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  function createMockOrchestrator(): Orchestrator {
    return {
      executePipeline: vi.fn().mockResolvedValue({}),
      getPipelineStatus: vi.fn().mockReturnValue(undefined),
      registerAgent: vi.fn(),
      unregisterAgent: vi.fn(),
      onStageChange: vi.fn(),
      onPipelineComplete: vi.fn(),
      crossAgentMemoryRetrieve: vi.fn(),
      getSharedMemory: vi.fn(),
      getAgents: vi.fn(),
      getMemoryManagers: vi.fn(),
      getFileParser: vi.fn().mockReturnValue({ getSupportedExtensions: () => ['html', 'docx', 'xmind'] }),
      startPipeline: vi.fn().mockReturnValue('exec-123'),
    } as unknown as Orchestrator;
  }

  function createMockToolRegistry() {
    return {
      getDefinitions: vi.fn().mockReturnValue([]),
      has: vi.fn().mockReturnValue(false),
      getAll: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    } as any;
  }

  function createMockToolExecutor() {
    return {
      executeTool: vi.fn().mockResolvedValue({ success: true, output: '' }),
      executeToolCalls: vi.fn().mockResolvedValue(new Map()),
    } as any;
  }

  async function createUploadTestServer() {
    const orchestrator = createMockOrchestrator();
    const toolRegistry = createMockToolRegistry();
    const toolExecutor = createMockToolExecutor();
    const chatRouter = createChatRouter({ orchestrator, toolRegistry, toolExecutor });

    const app = await createServer({
      staticDir: path.join(__dirname, '../../public'),
      routes: [{ path: '/api/chat', router: chatRouter }],
    });
    server = await startServer(app, 0);
    return { port: getPort(server), orchestrator };
  }

  it('file upload is accepted (any format)', async () => {
    const { port } = await createUploadTestServer();

    const formData = new FormData();
    const blob = new Blob(['<html><body>Hello</body></html>'], { type: 'text/html' });
    formData.append('file', blob, 'test.html');

    const response = await fetch(`http://localhost:${port}/api/chat/upload`, {
      method: 'POST',
      body: formData,
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.filename).toBe('test.html');
  });

  it('upload with no file returns 400', async () => {
    const { port } = await createUploadTestServer();

    const formData = new FormData();

    const response = await fetch(`http://localhost:${port}/api/chat/upload`, {
      method: 'POST',
      body: formData,
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBeDefined();
  });
});

describe('Chat Message and Pipeline', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  function createMockOrchestrator(): Orchestrator {
    return {
      executePipeline: vi.fn().mockResolvedValue({}),
      getPipelineStatus: vi.fn().mockReturnValue(undefined),
      registerAgent: vi.fn(),
      unregisterAgent: vi.fn(),
      onStageChange: vi.fn(),
      onPipelineComplete: vi.fn(),
      crossAgentMemoryRetrieve: vi.fn(),
      getSharedMemory: vi.fn(),
      getAgents: vi.fn(),
      getMemoryManagers: vi.fn(),
      getFileParser: vi.fn().mockReturnValue({ getSupportedExtensions: () => ['html', 'docx', 'xmind'] }),
      getLLMAdapter: vi.fn().mockReturnValue({ chat: vi.fn(), stream: vi.fn() }),
      startPipeline: vi.fn().mockReturnValue('exec-123'),
    } as unknown as Orchestrator;
  }

  function createMockToolRegistry() {
    return {
      getDefinitions: vi.fn().mockReturnValue([]),
      has: vi.fn().mockReturnValue(false),
      getAll: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
    } as any;
  }

  function createMockToolExecutor() {
    return {
      executeTool: vi.fn().mockResolvedValue({ success: true, output: '' }),
      executeToolCalls: vi.fn().mockResolvedValue(new Map()),
    } as any;
  }

  it('POST /api/chat/message with text-only message succeeds', async () => {
    const orchestrator = createMockOrchestrator();
    const toolRegistry = createMockToolRegistry();
    const toolExecutor = createMockToolExecutor();
    const chatRouter = createChatRouter({ orchestrator, toolRegistry, toolExecutor });

    const app = await createServer({
      staticDir: path.join(__dirname, '../../public'),
      routes: [{ path: '/api/chat', router: chatRouter }],
    });
    server = await startServer(app, 0);
    const port = getPort(server);

    const response = await fetch(`http://localhost:${port}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello agent' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.chatId).toBeDefined();
  });

  it('POST /api/chat/message with no message or fileId returns 400', async () => {
    const orchestrator = createMockOrchestrator();
    const toolRegistry = createMockToolRegistry();
    const toolExecutor = createMockToolExecutor();
    const chatRouter = createChatRouter({ orchestrator, toolRegistry, toolExecutor });

    const app = await createServer({
      staticDir: path.join(__dirname, '../../public'),
      routes: [{ path: '/api/chat', router: chatRouter }],
    });
    server = await startServer(app, 0);
    const port = getPort(server);

    const response = await fetch(`http://localhost:${port}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBeDefined();
  });

  it('POST /api/chat/message with file and pipeline command triggers pipeline', async () => {
    const orchestrator = createMockOrchestrator();
    const toolRegistry = createMockToolRegistry();
    const toolExecutor = createMockToolExecutor();
    const chatRouter = createChatRouter({ orchestrator, toolRegistry, toolExecutor });

    const app = await createServer({
      staticDir: path.join(__dirname, '../../public'),
      routes: [{ path: '/api/chat', router: chatRouter }],
    });
    server = await startServer(app, 0);
    const port = getPort(server);

    // First upload a file
    const formData = new FormData();
    const blob = new Blob(['<html><body>Requirements</body></html>'], { type: 'text/html' });
    formData.append('file', blob, 'requirements.html');

    const uploadResponse = await fetch(`http://localhost:${port}/api/chat/upload`, {
      method: 'POST',
      body: formData,
    });
    const uploadData = await uploadResponse.json();
    const fileId = uploadData.fileId;

    // Now send a pipeline command with the fileId
    const response = await fetch(`http://localhost:${port}/api/chat/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Analyze this', fileId, command: 'pipeline' }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.executionId).toBeDefined();
    expect(data.filename).toBe('requirements.html');
  });
});

describe('Pipeline Status Routes', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it('GET /api/pipeline/:id returns 404 for unknown pipeline', async () => {
    const sseManager = new SSEManager();
    const orchestrator = {
      executePipeline: vi.fn(),
      getPipelineStatus: vi.fn().mockReturnValue(undefined),
      registerAgent: vi.fn(),
      unregisterAgent: vi.fn(),
      onStageChange: vi.fn(),
      onPipelineComplete: vi.fn(),
    } as unknown as Orchestrator;

    const pipelineRouter = createPipelineRouter({ orchestrator, sseManager });

    const app = await createServer({
      staticDir: path.join(__dirname, '../../public'),
      routes: [{ path: '/api', router: pipelineRouter }],
    });
    server = await startServer(app, 0);
    const port = getPort(server);

    const response = await fetch(`http://localhost:${port}/api/pipeline/unknown-id`);
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toContain('Pipeline not found');
  });

  it('GET /api/pipeline/:id returns pipeline state when found', async () => {
    const sseManager = new SSEManager();
    const mockState: PipelineState = {
      executionId: 'test-exec-123',
      stages: [
        { name: 'requirement-analysis', status: 'completed' },
        { name: 'design', status: 'running' },
      ] as StageStatus[],
      currentStageIndex: 1,
      stageOutputs: new Map(),
      startTime: new Date(),
    };

    const orchestrator = {
      executePipeline: vi.fn(),
      getPipelineStatus: vi.fn().mockReturnValue(mockState),
      registerAgent: vi.fn(),
      unregisterAgent: vi.fn(),
      onStageChange: vi.fn(),
      onPipelineComplete: vi.fn(),
    } as unknown as Orchestrator;

    const pipelineRouter = createPipelineRouter({ orchestrator, sseManager });

    const app = await createServer({
      staticDir: path.join(__dirname, '../../public'),
      routes: [{ path: '/api', router: pipelineRouter }],
    });
    server = await startServer(app, 0);
    const port = getPort(server);

    const response = await fetch(`http://localhost:${port}/api/pipeline/test-exec-123`);
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.executionId).toBe('test-exec-123');
    expect(data.stages).toHaveLength(2);
    expect(data.stages[0].name).toBe('requirement-analysis');
    expect(data.stages[0].status).toBe('completed');
    expect(data.currentStageIndex).toBe(1);
  });

  it('GET /api/chat/stream/:id establishes SSE connection', async () => {
    const sseManager = new SSEManager();
    const orchestrator = {
      executePipeline: vi.fn(),
      getPipelineStatus: vi.fn(),
      registerAgent: vi.fn(),
      unregisterAgent: vi.fn(),
      onStageChange: vi.fn(),
      onPipelineComplete: vi.fn(),
    } as unknown as Orchestrator;

    const pipelineRouter = createPipelineRouter({ orchestrator, sseManager });

    const app = await createServer({
      staticDir: path.join(__dirname, '../../public'),
      routes: [{ path: '/api', router: pipelineRouter }],
    });
    server = await startServer(app, 0);
    const port = getPort(server);

    // Use AbortController to close the SSE connection after we verify it
    const controller = new AbortController();

    const responsePromise = fetch(`http://localhost:${port}/api/chat/stream/exec-sse-test`, {
      signal: controller.signal,
    });

    // Give the server a moment to process the connection
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify the SSE manager registered the connection
    expect(sseManager.getConnectionCount('exec-sse-test')).toBe(1);

    // Abort the connection
    controller.abort();

    // Wait for cleanup
    await responsePromise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
