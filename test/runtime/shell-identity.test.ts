import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readPersistedDataDirectory,
  readPersistedWorkspace,
  resolveSharedDefaultWorkDir,
  resolveSharedShellDir,
  writePersistedDataDirectory,
  writePersistedWorkspace,
} from '../../src/runtime/shell-identity.js';
import { resolveSharedShellDir as resolveDesktopSharedShellDir } from '../../desktop/src/paths.js';
import { writeDataDirectory, writeWorkspace } from '../../desktop/src/paths.js';
import { setStubUserData } from '../desktop/electron-stub.js';

describe('shell-identity 与 Electron 共用指针', () => {
  const prev = process.env.ICE_SHELL_IDENTITY_DIR;
  let tmp: string;
  let realDir: string;

  afterEach(() => {
    if (prev === undefined) delete process.env.ICE_SHELL_IDENTITY_DIR;
    else process.env.ICE_SHELL_IDENTITY_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(realDir, { recursive: true, force: true });
  });

  function setup(): void {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'shell-id-'));
    realDir = mkdtempSync(path.join(os.tmpdir(), 'shell-real-'));
    process.env.ICE_SHELL_IDENTITY_DIR = tmp;
    setStubUserData(tmp);
  }

  it('ICE_SHELL_IDENTITY_DIR 覆盖后 CLI 与 desktop 解析到同一目录', () => {
    setup();
    expect(resolveSharedShellDir()).toBe(path.resolve(tmp));
    expect(resolveDesktopSharedShellDir()).toBe(path.resolve(tmp));
  });

  it('Electron 写入的 data-directory.json 能被 npm 包读到', () => {
    setup();
    writeDataDirectory(realDir);
    expect(readPersistedDataDirectory()).toBe(path.resolve(realDir));
  });

  it('npm 包写入的数据目录指针 Electron 也能读到（同一文件）', () => {
    setup();
    writePersistedDataDirectory(realDir);
    expect(readPersistedDataDirectory()).toBe(path.resolve(realDir));
  });

  it('Electron 写入的 workspace.json 能被 npm 包读到', () => {
    setup();
    writeWorkspace(realDir);
    expect(readPersistedWorkspace()).toBe(path.resolve(realDir));
    expect(resolveSharedDefaultWorkDir(path.join(tmp, 'unused'))).toBe(path.resolve(realDir));
  });

  it('无工作区时默认工作目录回退到已存在的数据目录', () => {
    setup();
    writePersistedWorkspace(null);
    expect(resolveSharedDefaultWorkDir(realDir)).toBe(path.resolve(realDir));
  });

  it('相对路径写入数据目录会抛错', () => {
    setup();
    expect(() => writePersistedDataDirectory('relative/path')).toThrow(/绝对路径/);
  });
});
