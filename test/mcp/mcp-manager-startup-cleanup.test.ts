/**
 * MCPManager 启动失败清理回归测试（修复 P0-4）。
 *
 * 背景：startServer() 的 catch 仅把状态置为 error，但若 spawn 已成功、
 * 之后 initialize()/listTools() 失败，子进程会变成僵尸进程。修复后应在
 * 失败路径上显式调用 client.stop() 回收（stop 对未 spawn 的情况是安全空操作）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 共享受控行为：测试用例通过修改 ctrl.startImpl / ctrl.listToolsImpl 控制 fake client。
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

async function writeTempConfig(servers: Record<string, any>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-mcp-test-'));
  const file = path.join(dir, 'mcp.json');
  await fs.writeFile(file, JSON.stringify({ mcpServers: servers }), 'utf-8');
  return file;
}

describe('MCPManager 启动失败清理（P0-4）', () => {
  beforeEach(() => {
    ctrl.instances.length = 0;
    ctrl.startImpl = async () => {};
    ctrl.listToolsImpl = async () => [];
    vi.clearAllMocks();
  });

  it('spawn 成功但 listTools() 失败 → 调用 stop() 回收僵尸进程，状态置 error', async () => {
    ctrl.startImpl = async () => {}; // spawn + 握手成功
    ctrl.listToolsImpl = async () => {
      throw new Error('handshake failed after spawn');
    };
    const configPath = await writeTempConfig({
      svc: { command: 'node', args: ['x.js'], disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });

    await manager.initialize();

    expect(ctrl.instances.length).toBe(1);
    expect(ctrl.instances[0].stop).toHaveBeenCalledTimes(1);
    const info = manager.getServerInfos().find((s) => s.name === 'svc');
    expect(info?.status).toBe('error');
  });

  it('start() 直接抛错 → 也调用 stop()', async () => {
    ctrl.startImpl = async () => {
      throw new Error('spawn ENOENT');
    };
    const configPath = await writeTempConfig({
      svc: { command: 'node', args: ['x.js'], disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });

    await manager.initialize();

    expect(ctrl.instances.length).toBe(1);
    expect(ctrl.instances[0].stop).toHaveBeenCalledTimes(1);
  });

  it('正常启动成功时不调用 stop()', async () => {
    ctrl.startImpl = async () => {};
    ctrl.listToolsImpl = async () => [
      { name: 'demo', description: 'd', inputSchema: { type: 'object' } },
    ];
    const configPath = await writeTempConfig({
      svc: { command: 'node', args: ['x.js'], disabled: false },
    });
    const manager = new MCPManager({ mcpConfigPath: configPath });

    await manager.initialize();

    expect(ctrl.instances.length).toBe(1);
    expect(ctrl.instances[0].stop).not.toHaveBeenCalled();
    const info = manager.getServerInfos().find((s) => s.name === 'svc');
    expect(info?.status).toBe('ready');
  });
});
