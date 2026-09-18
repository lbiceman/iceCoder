/**
 * browsermcp 后端会话：进程保持 ready，工具列表不卸；puppeteer 走原路径。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ctrl = vi.hoisted(() => ({
  instances: [] as any[],
  startImpl: async () => {},
  listToolsImpl: async () => [] as { name: string; description?: string; inputSchema: object }[],
  callToolImpl: async (_name: string, _args: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    isError: false,
  }),
}));

vi.mock('../../src/mcp/mcp-client.js', () => {
  class FakeMCPClient {
    name: string;
    isReady = true;
    stop = vi.fn(async () => {});
    constructor(name: string) {
      this.name = name;
      ctrl.instances.push(this);
    }
    start() {
      return ctrl.startImpl();
    }
    listTools() {
      return ctrl.listToolsImpl();
    }
    callTool(toolName: string, args: Record<string, unknown>) {
      return ctrl.callToolImpl(toolName, args);
    }
  }
  return { MCPClient: FakeMCPClient };
});

import { MCPManager } from '../../src/mcp/mcp-manager.js';

async function writeTempConfig(servers: Record<string, unknown>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-mcp-backend-'));
  const file = path.join(dir, 'mcp.json');
  await fs.writeFile(file, JSON.stringify({ mcpServers: servers }), 'utf-8');
  return file;
}

describe('MCPManager browsermcp backend session', () => {
  beforeEach(() => {
    ctrl.instances.length = 0;
    ctrl.startImpl = async () => {};
    ctrl.listToolsImpl = async () => [];
    ctrl.callToolImpl = async () => ({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    vi.clearAllMocks();
  });

  it('扩展断连时进程仍 ready，工具还在，输出带 still ready 说明', async () => {
    ctrl.listToolsImpl = async () => [
      { name: 'browser_navigate', inputSchema: { type: 'object' } },
      { name: 'browser_snapshot', inputSchema: { type: 'object' } },
    ];
    ctrl.callToolImpl = async () => ({
      content: [{ type: 'text', text: 'No connection to browser extension' }],
      isError: true,
    });
    const configPath = await writeTempConfig({
      browsermcp: { command: 'node', args: ['x.js'], disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });
    await manager.initialize();

    const tools = manager.getRegisteredTools();
    const navigate = tools.find((t) => t.definition.name === 'mcp_browsermcp_browser_navigate');
    expect(navigate).toBeTruthy();
    const result = await navigate!.handler({ url: 'http://localhost/' });

    expect(result.success).toBe(false);
    expect(result.output).toContain('MCP process is still ready');
    expect(result.output).toContain('Do not switch to puppeteer');
    const info = manager.getServerInfos().find((s) => s.name === 'browsermcp');
    expect(info?.status).toBe('ready');
    expect(info?.backendKind).toBe('browser_extension');
    expect(info?.backendSession).toBe('detached');
    expect(manager.getRegisteredTools().some((t) => t.definition.name.startsWith('mcp_browsermcp_'))).toBe(true);
  });

  it('puppeteer 工具失败不标 backend、不改文案、不卸工具', async () => {
    ctrl.listToolsImpl = async () => [
      { name: 'puppeteer_navigate', inputSchema: { type: 'object' } },
    ];
    ctrl.callToolImpl = async () => ({
      content: [{ type: 'text', text: 'net::ERR_CONNECTION_CLOSED at https://example.com/' }],
      isError: true,
    });
    const configPath = await writeTempConfig({
      puppeteer: { command: 'node', args: ['x.js'], disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });
    await manager.initialize();
    const tool = manager.getRegisteredTools().find((t) => t.definition.name === 'mcp_puppeteer_puppeteer_navigate');
    const result = await tool!.handler({ url: 'https://example.com/' });
    expect(result.success).toBe(false);
    expect(result.output).toBe('net::ERR_CONNECTION_CLOSED at https://example.com/');
    expect(result.output).not.toContain('MCP process is still ready');
    const info = manager.getServerInfos().find((s) => s.name === 'puppeteer');
    expect(info?.status).toBe('ready');
    expect(info?.backendKind).toBe('none');
    expect(info?.backendSession).toBe('unknown');
  });

  it('HTTP MCP 进程错误仍按原路径标 error', async () => {
    ctrl.listToolsImpl = async () => [
      { name: 'create_issue', inputSchema: { type: 'object' } },
    ];
    ctrl.callToolImpl = async () => {
      throw new Error('fetch failed');
    };
    const configPath = await writeTempConfig({
      github: { type: 'streamablehttp', url: 'https://example.com/mcp', disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });
    await manager.initialize();
    const tool = manager.getRegisteredTools().find((t) => t.definition.name === 'mcp_github_create_issue');
    const result = await tool!.handler({ title: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('MCP 工具调用失败');
    expect(manager.getServerInfos().find((s) => s.name === 'github')?.status).toBe('error');
  });
});
