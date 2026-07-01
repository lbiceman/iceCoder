/**
 * MCPClient 工具级 JSON-RPC 错误不应抛异常（Puppeteer navigate 失败等）。
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
  proc.kill = vi.fn();
  return proc;
}

describe('MCPClient callTool JSON-RPC 错误', () => {
  let fakeProc: ReturnType<typeof createFakeProcess>;

  beforeEach(() => {
    fakeProc = createFakeProcess();
    spawnMock.mockReturnValue(fakeProc);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initialize 后 tools/call 返回 JSON-RPC error → MCPToolResult.isError，不抛异常', async () => {
    const client = new MCPClient('puppeteer', { command: 'node', args: ['x.js'] });
    const startPromise = client.start();

    let id = 0;
    fakeProc.stdout.on('data', () => {
      id += 1;
      if (id === 1) {
        fakeProc.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test', version: '1' } },
        }) + '\n');
      } else if (id === 2) {
        fakeProc.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          error: { code: -32603, message: 'net::ERR_CONNECTION_CLOSED at https://example.com/' },
        }) + '\n');
      }
    });

    await startPromise;

    const result = await client.callTool('puppeteer_navigate', { url: 'https://example.com/' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/ERR_CONNECTION_CLOSED/);

    await client.stop();
  });
});
