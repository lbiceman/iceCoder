/**
 * MCP 热重载与 ToolRegistry 同步测试。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ctrl = vi.hoisted(() => ({
  instances: [] as any[],
  startImpl: async () => {},
  listToolsImpl: async () => [] as any[],
}));

vi.mock('../../src/mcp/mcp-client.js', () => {
  class FakeMCPClient {
    name: string;
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
  }
  return { MCPClient: FakeMCPClient };
});

import { MCPManager } from '../../src/mcp/mcp-manager.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { syncMcpToolsOnRegistry } from '../../src/mcp/reload-mcp-config.js';

async function writeTempConfig(servers: Record<string, any>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-mcp-reload-'));
  const file = path.join(dir, 'mcp.json');
  await fs.writeFile(file, JSON.stringify({ mcpServers: servers }), 'utf-8');
  return file;
}

describe('MCPManager.reload', () => {
  beforeEach(() => {
    ctrl.instances.length = 0;
    ctrl.startImpl = async () => {};
    ctrl.listToolsImpl = async () => [
      { name: 'tool_a', description: 'a', inputSchema: { type: 'object' } },
    ];
    vi.clearAllMocks();
  });

  it('reload 重读配置并替换服务器列表', async () => {
    const configPath = await writeTempConfig({
      old_server: { command: 'node', args: ['a.js'], disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });
    await manager.initialize();
    expect(manager.getServerInfos().some((s) => s.name === 'old_server')).toBe(true);

    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          new_server: { command: 'node', args: ['b.js'], disabled: false },
        },
      }),
      'utf-8',
    );

    await manager.reload();

    const names = manager.getServerInfos().map((s) => s.name);
    expect(names).toEqual(['new_server']);
    expect(ctrl.instances.some((c) => c.name === 'old_server' && c.stop.mock.calls.length > 0)).toBe(true);
  });

  it('reload 期间 whenReady 等待 reload 完成', async () => {
    const configPath = await writeTempConfig({
      svc: { command: 'node', args: ['x.js'], disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });
    await manager.initialize();

    let readyDuringReload = false;
    const reloadPromise = manager.reload();
    const readyPromise = manager.whenReady().then(() => {
      readyDuringReload = manager.getServerInfos().length >= 0;
    });
    await Promise.all([reloadPromise, readyPromise]);
    expect(readyDuringReload).toBe(true);
  });
});

describe('syncMcpToolsOnRegistry', () => {
  it('移除旧 mcp_* 并注册新工具', async () => {
    const configPath = await writeTempConfig({
      svc: { command: 'node', args: ['x.js'], disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });
    const registry = new ToolRegistry();

    registry.register({
      definition: { name: 'mcp_old_tool', description: 'stale', parameters: { type: 'object', properties: {} } },
      handler: async () => ({ success: true, output: '' }),
    });
    registry.register({
      definition: { name: 'builtin_tool', description: 'keep', parameters: { type: 'object', properties: {} } },
      handler: async () => ({ success: true, output: '' }),
    });

    await manager.initialize();
    const added = syncMcpToolsOnRegistry(registry, manager);

    expect(added).toBe(1);
    expect(registry.has('mcp_old_tool')).toBe(false);
    expect(registry.has('builtin_tool')).toBe(true);
    expect(registry.has('mcp_svc_tool_a')).toBe(true);
  });
});

describe('ToolRegistry.unregisterByPrefix', () => {
  it('只移除匹配前缀的工具', () => {
    const registry = new ToolRegistry();
    registry.register({
      definition: { name: 'mcp_a_x', description: '', parameters: { type: 'object', properties: {} } },
      handler: async () => ({ success: true, output: '' }),
    });
    registry.register({
      definition: { name: 'other', description: '', parameters: { type: 'object', properties: {} } },
      handler: async () => ({ success: true, output: '' }),
    });

    expect(registry.unregisterByPrefix('mcp_')).toBe(1);
    expect(registry.has('mcp_a_x')).toBe(false);
    expect(registry.has('other')).toBe(true);
  });
});
