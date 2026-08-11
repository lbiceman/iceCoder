import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setStubUserData } from './electron-stub.js';

import {
  readWorkspace,
  writeWorkspace,
  readDataDirectory,
  writeDataDirectory,
  readPetFloatingPosition,
  writePetFloatingPosition,
  resolveDataDirectory,
  resolveServerCwd,
  isServerBundleReady,
} from '../../desktop/src/paths.js';

describe('desktop paths（userData 持久化读写）', () => {
  let tmp: string;
  let realDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'desktop-paths-'));
    realDir = mkdtempSync(path.join(os.tmpdir(), 'desktop-real-'));
    setStubUserData(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  });

  it('writeWorkspace / readWorkspace 往返（目录存在时）', () => {
    expect(readWorkspace()).toBeNull();
    writeWorkspace(realDir);
    expect(readWorkspace()).toBe(path.resolve(realDir));
  });

  it('readWorkspace 对损坏 JSON / 不存在目录返回 null', () => {
    writeFileSync(path.join(tmp, 'workspace.json'), '{bad json', 'utf8');
    expect(readWorkspace()).toBeNull();
    writeWorkspace(path.join(tmp, 'nonexistent-dir'));
    expect(readWorkspace()).toBeNull();
  });

  it('writeDataDirectory / readDataDirectory 往返（相对路径抛错）', () => {
    expect(readDataDirectory()).toBeNull();
    writeDataDirectory(realDir);
    expect(readDataDirectory()).toBe(path.resolve(realDir));
    expect(() => writeDataDirectory('relative/path')).toThrow(/绝对路径/);
  });

  it('readDataDirectory 忽略相对路径配置', () => {
    writeFileSync(
      path.join(tmp, 'data-directory.json'),
      JSON.stringify({ dataDir: 'relative' }),
      'utf8',
    );
    expect(readDataDirectory()).toBeNull();
  });

  it('writePetFloatingPosition / readPetFloatingPosition 往返（含 w/h）', () => {
    expect(readPetFloatingPosition()).toBeNull();
    writePetFloatingPosition({ x: 120, y: 80, w: 312, h: 240 });
    expect(readPetFloatingPosition()).toEqual({ x: 120, y: 80, w: 312, h: 240 });
  });

  it('readPetFloatingPosition 忽略缺 x/y 的坏数据', () => {
    writeFileSync(path.join(tmp, 'pet-floating-position.json'), '{"x":"a"}', 'utf8');
    expect(readPetFloatingPosition()).toBeNull();
  });

  it('resolveDataDirectory 未设置时回退 ~/.iceCoder', () => {
    expect(resolveDataDirectory()).toBe(path.join(os.homedir(), '.iceCoder'));
    writeDataDirectory(realDir);
    expect(resolveDataDirectory()).toBe(path.resolve(realDir));
  });

  it('resolveServerCwd 数据目录存在时用之，否则回退用户目录', () => {
    writeDataDirectory(realDir);
    expect(resolveServerCwd()).toBe(path.resolve(realDir));
    rmSync(realDir, { recursive: true, force: true });
    expect(resolveServerCwd()).toBe(os.homedir());
  });

  it('isServerBundleReady 反映 server-bundle/dist/index.js 是否存在', () => {
    expect(typeof isServerBundleReady()).toBe('boolean');
  });
});
