/**
 * MCPClient 应按服务器分别协商现代/旧协议，并在现代请求中携带完整 _meta。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { MCPClient } from '../../src/mcp/mcp-client.js';

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin.once('finish', () => {
    queueMicrotask(() => proc.emit('exit', 0, null));
  });
  proc.kill = vi.fn(() => {
    queueMicrotask(() => proc.emit('exit', 0, null));
    return true;
  });
  return proc;
}

type RequestMessage = {
  id?: number;
  method?: string;
  params?: Record<string, any>;
};

describe('MCPClient 协议协商', () => {
  let fakeProc: ReturnType<typeof createFakeProcess>;

  beforeEach(() => {
    fakeProc = createFakeProcess();
    spawnMock.mockReturnValue(fakeProc);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('现代服务器：使用 server/discover，所有请求携带 2026-07-28 元数据', async () => {
    const requests: RequestMessage[] = [];
    fakeProc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        const request = JSON.parse(line) as RequestMessage;
        requests.push(request);

        if (request.id != null && request.method === 'server/discover') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
              ttlMs: 60_000,
              cacheScope: 'public',
            },
          }) + '\n');
        } else if (request.id != null && request.method === 'tools/list') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              tools: [{ name: 'browser_open', inputSchema: { type: 'object' } }],
              ttlMs: 60_000,
              cacheScope: 'public',
            },
          }) + '\n');
        } else if (request.id != null && request.method === 'tools/call') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              content: [{ type: 'text', text: 'ok' }],
            },
          }) + '\n');
        }
      }
    });

    const client = new MCPClient('browser', { command: 'node', args: ['server.js'] });
    await client.start();
    await expect(client.listTools()).resolves.toHaveLength(1);
    await expect(client.callTool('browser_open', { url: 'https://example.com' }))
      .resolves.toMatchObject({ content: [{ text: 'ok' }] });

    expect(requests.some((request) => request.method === 'initialize')).toBe(false);
    for (const request of requests.filter((item) => item.id != null)) {
      expect(request.params?._meta).toMatchObject({
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'ice-coder', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      });
    }

    await client.stop();
  });

  it('旧服务器：discover 返回普通错误后回退 initialize，后续请求不带现代元数据', async () => {
    const requests: RequestMessage[] = [];
    fakeProc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        const request = JSON.parse(line) as RequestMessage;
        requests.push(request);

        if (request.id != null && request.method === 'server/discover') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Method not found' },
          }) + '\n');
        } else if (request.id != null && request.method === 'initialize') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: { protocolVersion: '2024-11-05', capabilities: {} },
          }) + '\n');
        } else if (request.id != null && request.method === 'tools/list') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: { tools: [] },
          }) + '\n');
        }
      }
    });

    const client = new MCPClient('legacy', { command: 'node', args: ['server.js'] });
    await client.start();
    await client.listTools();

    const initialize = requests.find((request) => request.method === 'initialize');
    const toolsList = requests.find((request) => request.method === 'tools/list');
    expect(initialize?.params?._meta).toBeUndefined();
    expect(toolsList?.params?._meta).toBeUndefined();

    await client.stop();
    expect(requests.some((request) => request.method === 'notifications/cancelled')).toBe(false);
    expect(fakeProc.stdin.writableEnded).toBe(true);
  });

  it('旧服务器忽略 discover 时，短超时后仍能回退 initialize', async () => {
    vi.useFakeTimers();
    const methods: string[] = [];
    fakeProc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        const request = JSON.parse(line) as RequestMessage;
        if (request.method) methods.push(request.method);
        // 故意不响应 server/discover，模拟会保持静默的旧实现。
        if (request.id != null && request.method === 'initialize') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: { protocolVersion: '2024-11-05', capabilities: {} },
          }) + '\n');
        }
      }
    });

    const client = new MCPClient('silent-legacy', { command: 'node', args: ['server.js'] });
    try {
      const startPromise = client.start();
      await vi.advanceTimersByTimeAsync(3_000);
      await startPromise;
      expect(methods).toEqual(['server/discover', 'initialize', 'notifications/initialized']);
    } finally {
      vi.useRealTimers();
      await client.stop();
    }
  });

  it('现代版本不兼容时明确失败，不错误回退 initialize', async () => {
    const methods: string[] = [];
    fakeProc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        const request = JSON.parse(line) as RequestMessage;
        if (request.method) methods.push(request.method);
        if (request.id != null && request.method === 'server/discover') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32022,
              message: 'Unsupported protocol version',
              data: { supported: ['2027-01-01'], requested: '2026-07-28' },
            },
          }) + '\n');
        }
      }
    });

    const client = new MCPClient('future', { command: 'node', args: ['server.js'] });
    await expect(client.start()).rejects.toThrow(/现代协议服务器.*不支持客户端版本/);
    expect(methods).toEqual(['server/discover']);

    await client.stop();
  });

  it('其他现代专用错误也不能误回退 initialize', async () => {
    const methods: string[] = [];
    fakeProc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        const request = JSON.parse(line) as RequestMessage;
        if (request.method) methods.push(request.method);
        if (request.id != null && request.method === 'server/discover') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32021,
              message: 'Missing required client capability',
              data: { requiredCapabilities: { elicitation: {} } },
            },
          }) + '\n');
        }
      }
    });

    const client = new MCPClient('modern-error', { command: 'node', args: ['server.js'] });
    await expect(client.start()).rejects.toThrow(/现代协议错误.*不能回退 legacy/);
    expect(methods).toEqual(['server/discover']);

    await client.stop();
  });

  it('现代 server/discover 拒绝未知 resultType，不误回退 legacy', async () => {
    const methods: string[] = [];
    fakeProc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        const request = JSON.parse(line) as RequestMessage;
        if (request.method) methods.push(request.method);
        if (request.id != null && request.method === 'server/discover') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'future_result',
              supportedVersions: ['2026-07-28'],
              capabilities: {},
              ttlMs: 60_000,
              cacheScope: 'public',
            },
          }) + '\n');
        }
      }
    });

    const client = new MCPClient('invalid-result', { command: 'node', args: ['server.js'] });
    await expect(client.start()).rejects.toThrow(/server\/discover 返回无效 resultType/);
    expect(methods).toEqual(['server/discover']);

    await client.stop();
  });

  it('现代工具返回 input_required 时明确报告暂不支持 MRTR', async () => {
    fakeProc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        const request = JSON.parse(line) as RequestMessage;
        if (request.id != null && request.method === 'server/discover') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
              ttlMs: 60_000,
              cacheScope: 'public',
            },
          }) + '\n');
        } else if (request.id != null && request.method === 'tools/call') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'input_required',
              requestState: 'opaque-retry-state',
            },
          }) + '\n');
        }
      }
    });

    const client = new MCPClient('modern', { command: 'node', args: ['server.js'] });
    await client.start();
    const result = await client.callTool('dangerous_action', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/尚未支持 MRTR/);

    await client.stop();
  });

  it('现代 tools/list 只接受 complete 结果', async () => {
    fakeProc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        const request = JSON.parse(line) as RequestMessage;
        if (request.id != null && request.method === 'server/discover') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
              ttlMs: 60_000,
              cacheScope: 'public',
            },
          }) + '\n');
        } else if (request.id != null && request.method === 'tools/list') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: { resultType: 'input_required', requestState: 'invalid-for-list' },
          }) + '\n');
        }
      }
    });

    const client = new MCPClient('invalid-tools-list', { command: 'node', args: ['server.js'] });
    await client.start();
    await expect(client.listTools()).rejects.toThrow(/tools\/list 返回无效 resultType/);

    await client.stop();
  });

  it('现代工具调用发生协议版本失配时抛出连接级错误', async () => {
    fakeProc.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        const request = JSON.parse(line) as RequestMessage;
        if (request.id != null && request.method === 'server/discover') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              resultType: 'complete',
              supportedVersions: ['2026-07-28'],
              capabilities: { tools: {} },
              ttlMs: 60_000,
              cacheScope: 'public',
            },
          }) + '\n');
        } else if (request.id != null && request.method === 'tools/call') {
          fakeProc.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: {
              code: -32022,
              message: 'Unsupported protocol version',
              data: { supported: ['2027-01-01'], requested: '2026-07-28' },
            },
          }) + '\n');
        }
      }
    });

    const client = new MCPClient('version-drift', { command: 'node', args: ['server.js'] });
    await client.start();
    await expect(client.callTool('browser_open', {}))
      .rejects.toThrow(/MCP error \[-32022\]/);

    await client.stop();
  });
});
