import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyWorkspaceFileSnapshot,
  collectPathsToDeleteOnRestore,
  extractLikelyFilePathsFromText,
  remapPathToWorkspace,
  resolveLikelyPathsInWorkspace,
} from '../../src/harness/workspace-snapshot.js';

describe('workspace-snapshot path hints', () => {
  it('extracts bare css filenames and nested paths from user text', () => {
    const paths = extractLikelyFilePathsFromText('修改 tokens.css 中夜间模式的主题色');
    expect(paths).toContain('tokens.css');

    const nested = extractLikelyFilePathsFromText('请改 src/public/css/tokens.css 里的 accent');
    expect(nested).toContain('src/public/css/tokens.css');
  });

  it('resolves bare filenames under workspace root', async () => {
    const resolved = await resolveLikelyPathsInWorkspace(process.cwd(), ['tokens.css']);
    expect(resolved.some((p) => p.endsWith('tokens.css'))).toBe(true);
  });
});

describe('remapPathToWorkspace', () => {
  it('strips a parent prefix that repeats the locked workspace tail', () => {
    const root = path.join(os.tmpdir(), 'test', 'agentToolTest', '20260910');
    expect(remapPathToWorkspace(root, 'test/agentToolTest/20260910/empty.txt')).toBe('empty.txt');
  });

  it('does not strip src/foo.ts when the workspace basename is not src', () => {
    const root = path.join(os.tmpdir(), 'iceCoder');
    expect(remapPathToWorkspace(root, 'src/foo.ts')).toBe('src/foo.ts');
  });

  it('maps an absolute path inside the workspace to a relative posix path', () => {
    const root = path.join(os.tmpdir(), 'test', 'agentToolTest', '20260910');
    expect(remapPathToWorkspace(root, path.join(root, 'empty.txt'))).toBe('empty.txt');
  });

  it('collectPathsToDeleteOnRestore remaps later paths onto workspace-relative keys', () => {
    const root = path.join(os.tmpdir(), 'test', 'agentToolTest', '20260910');
    expect(collectPathsToDeleteOnRestore(
      {},
      ['test/agentToolTest/20260910/empty.txt'],
      root,
    )).toEqual(['empty.txt']);
    expect(collectPathsToDeleteOnRestore(
      { 'empty.txt': null },
      ['test/agentToolTest/20260910/empty.txt'],
      root,
    )).toEqual(['empty.txt']);
    expect(collectPathsToDeleteOnRestore(
      { 'empty.txt': '' },
      ['test/agentToolTest/20260910/empty.txt'],
      root,
    )).toEqual([]);
  });

  it('applyWorkspaceFileSnapshot deletes the real file when the archive key has a parent prefix', async () => {
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-remap-apply-'));
    const root = path.join(tmpRoot, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(root, { recursive: true });
    const abs = path.join(root, 'empty.txt');
    await fs.writeFile(abs, '', 'utf-8');
    const nested = path.join(root, 'test', 'agentToolTest', '20260910', 'empty.txt');

    await applyWorkspaceFileSnapshot(
      root,
      { 'test/agentToolTest/20260910/empty.txt': null },
      [],
    );

    await expect(fs.access(abs)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(nested)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});
