import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openWorkspaceChangedFile,
  resolveOpenableWorkspaceFile,
} from '../../src/web/open-workspace-file.js';

describe('resolveOpenableWorkspaceFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-ws-'));
    await fs.mkdir(path.join(root, 'notes'), { recursive: true });
    await fs.writeFile(path.join(root, 'notes', 'todo.md'), 'hi\n', 'utf-8');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('解析工作区内的相对路径', async () => {
    const result = await resolveOpenableWorkspaceFile('notes/todo.md', [root]);
    expect(result).toEqual({ absPath: path.resolve(root, 'notes', 'todo.md') });
  });

  it('拒绝穿越到工作区外', async () => {
    const result = await resolveOpenableWorkspaceFile('../secret.txt', [root]);
    expect(result).toMatchObject({ status: 403, error: '路径不在工作区内' });
  });

  it('文件不存在时返回 404', async () => {
    const result = await resolveOpenableWorkspaceFile('notes/missing.md', [root]);
    expect(result).toMatchObject({ status: 404, error: '文件不存在或已删除' });
  });

  it('目录不能打开', async () => {
    const result = await resolveOpenableWorkspaceFile('notes', [root]);
    expect(result).toMatchObject({ status: 400, error: '只能打开文件' });
  });
});

describe('openWorkspaceChangedFile', () => {
  let sessionsDir: string;
  let workDir: string;
  const prevDefaultWorkDir = process.env.ICE_DEFAULT_WORK_DIR;

  beforeEach(async () => {
    sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-sess-'));
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'open-wd-'));
    process.env.ICE_DEFAULT_WORK_DIR = workDir;
    await fs.writeFile(path.join(workDir, 'kept.ts'), 'export {}\n', 'utf-8');
    await fs.writeFile(
      path.join(sessionsDir, 's1.checkpoint-index.json'),
      JSON.stringify({
        version: 1,
        cursorMessageId: null,
        entries: [],
        sessionTouchedPaths: ['kept.ts'],
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    if (prevDefaultWorkDir === undefined) delete process.env.ICE_DEFAULT_WORK_DIR;
    else process.env.ICE_DEFAULT_WORK_DIR = prevDefaultWorkDir;
    await fs.rm(sessionsDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  });

  it('只打开本会话变更列表里的文件', async () => {
    const opened: string[] = [];
    const ok = await openWorkspaceChangedFile({
      sessionsDir,
      sessionId: 's1',
      relPath: 'kept.ts',
      defaultWorkDir: workDir,
      openPath: async (abs) => {
        opened.push(abs);
        return true;
      },
    });
    expect(ok).toEqual({ ok: true, status: 200, absPath: path.resolve(workDir, 'kept.ts') });
    expect(opened).toEqual([path.resolve(workDir, 'kept.ts')]);
  });

  it('拒绝打开未记入变更列表的工作区文件', async () => {
    await fs.writeFile(path.join(workDir, 'other.ts'), 'x\n', 'utf-8');
    const openPath = vi.fn(async () => true);
    const result = await openWorkspaceChangedFile({
      sessionsDir,
      sessionId: 's1',
      relPath: 'other.ts',
      defaultWorkDir: workDir,
      openPath,
    });
    expect(result).toMatchObject({ ok: false, status: 403, error: '文件不在本会话变更列表中' });
    expect(openPath).not.toHaveBeenCalled();
  });

  it('系统打开失败时返回 500', async () => {
    const result = await openWorkspaceChangedFile({
      sessionsDir,
      sessionId: 's1',
      relPath: 'kept.ts',
      defaultWorkDir: workDir,
      openPath: async () => false,
    });
    expect(result).toMatchObject({ ok: false, status: 500, error: '无法用系统默认程序打开' });
  });
});
