import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync } from 'node:fs';

import {
  augmentPathForShellSpawn,
  applyWindowsPathDefaults,
  resolveShellExecutable,
  resolveWindowsShellExecutable,
  resolveWindowsSystemExecutable,
  standardWindowsPathDirs,
} from '../../src/tools/shell-spawn-env.js';
import { buildShellChildEnv } from '../../src/tools/shell-host-guard.js';

describe('shell-spawn-env', () => {
  it('standardWindowsPathDirs 包含 System32', () => {
    if (process.platform !== 'win32') return;
    const dirs = standardWindowsPathDirs();
    expect(dirs.some((d) => d.toLowerCase().endsWith('\\system32'))).toBe(true);
  });

  it('augmentPathForShellSpawn 前置 System32 即使原 PATH 不含', () => {
    if (process.platform !== 'win32') return;
    const augmented = augmentPathForShellSpawn('C:\\custom\\bin');
    expect(augmented.toLowerCase()).toContain('system32');
    expect(augmented).toContain('C:\\custom\\bin');
    const first = augmented.split(';')[0].toLowerCase();
    expect(first).toContain('system32');
  });

  it('resolveWindowsShellExecutable 返回存在的绝对路径', () => {
    if (process.platform !== 'win32') return;
    const shell = resolveWindowsShellExecutable();
    expect(path.isAbsolute(shell)).toBe(true);
    expect(existsSync(shell)).toBe(true);
    expect(path.basename(shell).toLowerCase()).toBe('cmd.exe');
  });

  it('resolveShellExecutable 在 Windows 上解析 cmd', () => {
    if (process.platform !== 'win32') return;
    const shell = resolveShellExecutable();
    expect(path.basename(shell).toLowerCase()).toBe('cmd.exe');
    expect(existsSync(shell)).toBe(true);
  });

  it('buildShellChildEnv 补全 PATH', () => {
    if (process.platform !== 'win32') return;
    const env = buildShellChildEnv('sess-x');
    expect(env.PATH?.toLowerCase()).toContain('system32');
    expect(env.ICE_AGENT_SESSION).toBe('sess-x');
  });

  it('resolveWindowsSystemExecutable 解析 taskkill 绝对路径', () => {
    if (process.platform !== 'win32') return;
    const taskkill = resolveWindowsSystemExecutable('taskkill');
    expect(path.isAbsolute(taskkill)).toBe(true);
    expect(existsSync(taskkill)).toBe(true);
    expect(path.basename(taskkill).toLowerCase()).toBe('taskkill.exe');
  });

  it('applyWindowsPathDefaults 补全宿主 PATH', () => {
    if (process.platform !== 'win32') return;
    const saved = process.env.PATH;
    process.env.PATH = 'C:\\only-custom';
    applyWindowsPathDefaults();
    expect(process.env.PATH?.toLowerCase()).toContain('system32');
    expect(process.env.PATH).toContain('C:\\only-custom');
    process.env.PATH = saved;
  });
});
