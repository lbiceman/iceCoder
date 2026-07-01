import { describe, it, expect } from 'vitest';
import {
  augmentPathForMcpSpawn,
  extractNpxPackageName,
  resolveMcpCommand,
  resolveMcpServerLaunch,
} from '../../src/mcp/resolve-mcp-command.js';

describe('resolveMcpCommand', () => {
  it('Windows 上将 npx 解析为 PATH 中的 npx.cmd', () => {
    if (process.platform !== 'win32') return;
    const fakeDir = 'C:\\fake-nodejs';
    const resolved = resolveMcpCommand('npx', `${fakeDir};C:\\Windows`);
    expect(resolved).toBe('npx.cmd');
  });

  it('augmentPathForMcpSpawn 前置常见 Node 目录', () => {
    const augmented = augmentPathForMcpSpawn('C:\\existing');
    expect(augmented.startsWith('C:\\existing')).toBe(false);
    if (process.platform === 'win32') {
      expect(augmented).toContain('nodejs');
    }
  });

  it('非 npx 命令保持原样', () => {
    const cmd = 'C:\\Python\\python.exe';
    expect(resolveMcpCommand(cmd)).toBe(cmd);
  });

  it('extractNpxPackageName 解析 npx 参数', () => {
    expect(extractNpxPackageName(['-y', '@modelcontextprotocol/server-puppeteer'])).toBe(
      '@modelcontextprotocol/server-puppeteer',
    );
  });

  it('resolveMcpServerLaunch 对 npx 包优先 bundled 直连', () => {
    const plan = resolveMcpServerLaunch({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    });
    if (plan.launchMode === 'bundled') {
      expect(plan.args[0]).toMatch(/server-puppeteer/);
      expect(plan.command.length).toBeGreaterThan(0);
    } else {
      expect(plan.launchMode).toBe('npx');
    }
  });
});
