/**
 * MCP 配置持久化（disabled 写回 mcp.json）测试。
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
import {
  addMcpServerConfig,
  getMcpServerConfig,
  isMcpConfigWatchSuppressed,
  removeMcpServerConfig,
  updateMcpServerConfig,
  validateMcpServerConfig,
} from '../../src/mcp/persist-mcp-config.js';

async function writeTempConfig(servers: Record<string, any>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-mcp-persist-'));
  const file = path.join(dir, 'mcp.json');
  await fs.writeFile(file, JSON.stringify({ mcpServers: servers }, null, 2) + '\n', 'utf-8');
  return file;
}

describe('MCP 启停持久化', () => {
  beforeEach(() => {
    ctrl.instances.length = 0;
    ctrl.startImpl = async () => {};
    ctrl.listToolsImpl = async () => [
      { name: 'tool_a', description: 'a', inputSchema: { type: 'object' } },
    ];
    vi.clearAllMocks();
  });

  it('stopServer 写入 disabled: true 到 mcp.json', async () => {
    const configPath = await writeTempConfig({
      svc: { command: 'node', args: ['x.js'], disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });
    await manager.initialize();

    await manager.stopServer('svc');

    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(onDisk.mcpServers.svc.disabled).toBe(true);
    expect(manager.getServerInfos().find((s) => s.name === 'svc')?.status).toBe('disabled');
    expect(isMcpConfigWatchSuppressed()).toBe(true);
  });

  it('startServerByName 写入 disabled: false 并启动', async () => {
    const configPath = await writeTempConfig({
      svc: { command: 'node', args: ['x.js'], disabled: true },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });
    await manager.initialize();

    expect(manager.getServerInfos().find((s) => s.name === 'svc')?.status).toBe('disabled');

    await manager.startServerByName('svc');

    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(onDisk.mcpServers.svc.disabled).toBe(false);
    expect(manager.getServerInfos().find((s) => s.name === 'svc')?.status).toBe('ready');
  });
});

describe('MCP 配置读写', () => {
  it('getMcpServerConfig 返回完整条目', async () => {
    const configPath = await writeTempConfig({
      svc: { command: 'npx', args: ['-y', 'pkg'], env: { FOO: 'bar' }, disabled: true },
    });
    const cfg = await getMcpServerConfig(configPath, 'svc');
    expect(cfg.command).toBe('npx');
    expect(cfg.env).toEqual({ FOO: 'bar' });
  });

  it('updateMcpServerConfig 更新已有服务器', async () => {
    const configPath = await writeTempConfig({
      svc: { command: 'node', args: ['a.js'], disabled: false },
    });
    await updateMcpServerConfig(configPath, 'svc', {
      command: 'node',
      args: ['b.js'],
      disabled: true,
    });
    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(onDisk.mcpServers.svc.args).toEqual(['b.js']);
    expect(onDisk.mcpServers.svc.disabled).toBe(true);
    expect(isMcpConfigWatchSuppressed()).toBe(true);
  });

  it('addMcpServerConfig 新增服务器', async () => {
    const configPath = await writeTempConfig({
      a: { command: 'node', args: ['a.js'] },
    });
    await addMcpServerConfig(configPath, 'b', { command: 'npx', args: ['-y', 'pkg'] });
    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(Object.keys(onDisk.mcpServers)).toEqual(['a', 'b']);
  });

  it('validateMcpServerConfig 拒绝缺少 command', () => {
    expect(() => validateMcpServerConfig({ args: [] })).toThrow(/command/);
  });

  it('removeMcpServerConfig 删除服务器', async () => {
    const configPath = await writeTempConfig({
      a: { command: 'node', args: ['a.js'] },
      b: { command: 'node', args: ['b.js'] },
    });
    await removeMcpServerConfig(configPath, 'a');
    const onDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    expect(Object.keys(onDisk.mcpServers)).toEqual(['b']);
  });
});
