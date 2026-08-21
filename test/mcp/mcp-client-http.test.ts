/**
 * MCPClient Streamable HTTP：远程 type:streamablehttp 不再走 stdio spawn。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPClient } from '../../src/mcp/mcp-client.js';

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const rec = headers as Record<string, string>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? rec[key] : null;
}

describe('MCPClient Streamable HTTP', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('initialize + tools/list 走 POST，并回传 Mcp-Session-Id 与 Authorization', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      expect(header(init, 'Authorization')).toBe('Bearer test-token');
      expect(header(init, 'Accept')).toContain('application/json');
      expect(header(init, 'Accept')).toContain('text/event-stream');

      if (body.method === 'initialize') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'mcd', version: '1' },
          },
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Mcp-Session-Id': 'sess-1',
          },
        });
      }

      if (body.method === 'notifications/initialized') {
        expect(header(init, 'Mcp-Session-Id')).toBe('sess-1');
        return new Response(null, { status: 202 });
      }

      if (body.method === 'tools/list') {
        expect(header(init, 'Mcp-Session-Id')).toBe('sess-1');
        expect(header(init, 'MCP-Protocol-Version')).toBe('2025-06-18');
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            tools: [{ name: 'lookup', description: '查询', inputSchema: { type: 'object' } }],
          },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (init?.method === 'DELETE') {
        return new Response(null, { status: 405 });
      }

      throw new Error(`unexpected method ${body.method}`);
    });

    const client = new MCPClient('mcd-mcp', {
      type: 'streamablehttp',
      url: 'https://mcp.example.com',
      headers: { Authorization: 'Bearer test-token' },
    });

    await client.start();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['lookup']);
    expect(client.isReady).toBe(true);

    await client.stop();
    const methods = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit | undefined;
      if (init?.method === 'DELETE') return 'DELETE';
      return JSON.parse(String(init?.body ?? '{}')).method ?? init?.method;
    });
    expect(methods).toContain('initialize');
    expect(methods).toContain('notifications/initialized');
    expect(methods).toContain('tools/list');
    expect(methods).toContain('DELETE');
  });

  it('支持 SSE 包裹的 JSON-RPC 响应', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      if (body.method === 'initialize') {
        const sse = [
          'event: message',
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-06-18', capabilities: {} },
          })}`,
          '',
          '',
        ].join('\n');
        return new Response(sse, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 's2' },
        });
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 405 });
      }
      throw new Error(`unexpected ${body.method}`);
    });

    const client = new MCPClient('sse-http', {
      type: 'http',
      url: 'https://mcp.example.com/mcp',
    });
    await client.start();
    expect(client.isReady).toBe(true);
    await client.stop();
  });

  it('401 给出认证相关错误而不是 path undefined', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const client = new MCPClient('mcd-mcp', {
      type: 'streamablehttp',
      url: 'https://mcp.example.com',
    });
    await expect(client.start()).rejects.toThrow(/HTTP 401/);
  });

  it('type:sse 给出明确不支持提示', async () => {
    const client = new MCPClient('old', {
      type: 'sse',
      url: 'https://mcp.example.com/sse',
    });
    await expect(client.start()).rejects.toThrow(/sse/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
