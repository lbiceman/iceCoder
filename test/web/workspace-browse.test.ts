/**
 * 工作区目录浏览 API 与隐藏目录过滤
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  HIDDEN_DIR_NAMES,
  isHiddenDirName,
  isSkippedEntry,
  listWorkspaceDirectory,
  resolvePathUnderWorkspace,
  assertUnderWorkspaceRoot,
  scorePathFuzzy,
  scoreFuzzySubsequence,
  searchWorkspaceFiles,
} from '../../src/web/workspace-browse.js';

function getPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

describe('workspace-browse core', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-browse-'));
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.mkdir(path.join(tempDir, 'src', 'harness'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'index.ts'), 'export {};\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'src', 'harness', 'harness.ts'), 'export {};\n', 'utf-8');
    await fs.writeFile(path.join(tempDir, 'src', 'harness-tool.ts'), 'export {};\n', 'utf-8');
    await fs.mkdir(path.join(tempDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'node_modules', 'pkg.js'), '', 'utf-8');
    await fs.mkdir(path.join(tempDir, '.git'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('isHiddenDirName covers common dependency folders', () => {
    expect(isHiddenDirName('node_modules')).toBe(true);
    expect(isHiddenDirName('NODE_MODULES')).toBe(true);
    expect(isHiddenDirName('__pycache__')).toBe(true);
    expect(isHiddenDirName('src')).toBe(false);
  });

  it('listWorkspaceDirectory hides default ignored dirs', async () => {
    const result = await listWorkspaceDirectory(tempDir);
    const names = result.entries.map((e) => e.name);
    expect(names).toContain('src');
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
  });

  it('resolvePathUnderWorkspace rejects traversal outside root', () => {
    expect(() => resolvePathUnderWorkspace(tempDir, '../')).toThrow(/outside workspace/);
  });

  it('listWorkspaceDirectory returns absolute paths', async () => {
    const result = await listWorkspaceDirectory(tempDir);
    const src = result.entries.find((e) => e.name === 'src');
    expect(src?.path).toBe(path.join(tempDir, 'src'));
    expect(src?.isDirectory).toBe(true);
  });

  it('HIDDEN_DIR_NAMES includes java/python ecosystem dirs', () => {
    expect(HIDDEN_DIR_NAMES.has('.gradle')).toBe(true);
    expect(HIDDEN_DIR_NAMES.has('target')).toBe(true);
    expect(HIDDEN_DIR_NAMES.has('.venv')).toBe(true);
    expect(HIDDEN_DIR_NAMES.has('site-packages')).toBe(true);
  });

  it('scoreFuzzySubsequence ranks tighter matches higher', () => {
    expect(scoreFuzzySubsequence('harness.ts', 'harness.ts'))
      .toBeGreaterThan(scoreFuzzySubsequence('harness-tool.ts', 'harness.ts'));
    expect(scoreFuzzySubsequence('harness.ts', 'harness'))
      .toBeGreaterThan(scoreFuzzySubsequence('other.ts', 'harness'));
  });

  it('scorePathFuzzy matches abbreviated path queries like sr/hars', () => {
    const target = 'src/harness/harness.ts';
    expect(scorePathFuzzy(target, 'sr/hars')).toBeGreaterThan(0);
    expect(scorePathFuzzy(target, 's/ha')).toBeGreaterThan(0);
    expect(scorePathFuzzy(target, 'src/harness.ts')).toBeGreaterThan(scorePathFuzzy(target, 'sr/hars'));
  });

  it('searchWorkspaceFiles finds nested files by path fuzzy query', async () => {
    const exact = await searchWorkspaceFiles(tempDir, 'harness.ts');
    const names = exact.entries.map((e) => e.name);
    expect(names).toContain('harness.ts');
    expect(names).not.toContain('index.ts');

    const fuzzy = await searchWorkspaceFiles(tempDir, 'harness');
    const fuzzyNames = fuzzy.entries.map((e) => e.name);
    expect(fuzzyNames).toContain('harness.ts');
    expect(fuzzyNames).toContain('harness-tool.ts');

    const pathFuzzy = await searchWorkspaceFiles(tempDir, 'sr/hars');
    expect(pathFuzzy.entries.some((e) => e.relativePath.replace(/\\/g, '/').includes('harness/harness.ts'))).toBe(true);
  });

  it('searchWorkspaceFiles skips node_modules', async () => {
    await fs.writeFile(path.join(tempDir, 'node_modules', 'harness.ts'), '', 'utf-8');
    const results = await searchWorkspaceFiles(tempDir, 'harness.ts');
    expect(results.entries.every((e) => !e.path.includes('node_modules'))).toBe(true);
  });

  it('isSkippedEntry hides dot-prefixed entries', () => {
    expect(isSkippedEntry('.env', false)).toBe(true);
    expect(isSkippedEntry('src', true)).toBe(false);
  });
});

describe('workspace browse API', () => {
  let tempDir: string;
  let sessionsDir: string;
  let server: Server;
  let baseUrl: string;
  let searchUrl: string;
  const prevSessionsDir = process.env.ICE_SESSIONS_DIR;
  const prevDefaultWorkDir = process.env.ICE_DEFAULT_WORK_DIR;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-browse-api-'));
    sessionsDir = path.join(tempDir, 'sessions');
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, 'visible'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'visible', 'a.txt'), 'hi', 'utf-8');
    await fs.mkdir(path.join(tempDir, 'src', 'harness'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'harness', 'harness.ts'), 'x', 'utf-8');
    await fs.mkdir(path.join(tempDir, 'node_modules'), { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, 'default.workspace.json'),
      JSON.stringify({ referenceReads: [], changeCount: 0, lockedRoot: tempDir }),
      'utf-8',
    );
    process.env.ICE_SESSIONS_DIR = sessionsDir;

    vi.resetModules();
    const { createWorkspaceBrowseRouter } = await import('../../src/web/routes/workspace-browse.js');
    const app = express();
    app.use('/api/workspace', createWorkspaceBrowseRouter());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${getPort(server)}/api/workspace/browse`;
    searchUrl = `http://127.0.0.1:${getPort(server)}/api/workspace/search`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    if (prevSessionsDir === undefined) delete process.env.ICE_SESSIONS_DIR;
    else process.env.ICE_SESSIONS_DIR = prevSessionsDir;
    if (prevDefaultWorkDir === undefined) delete process.env.ICE_DEFAULT_WORK_DIR;
    else process.env.ICE_DEFAULT_WORK_DIR = prevDefaultWorkDir;
  });

  it('GET /browse lists cwd when no dir param', async () => {
    const res = await fetch(`${baseUrl}?sessionId=default`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { success: boolean; entries: { name: string }[] };
    expect(body.success).toBe(true);
    const names = body.entries.map((e) => e.name);
    expect(names).toContain('visible');
    expect(names).not.toContain('node_modules');
  });

  it('GET /browse uses default workdir when session workspace is not locked', async () => {
    await fs.rm(path.join(sessionsDir, 'default.workspace.json'), { force: true });
    process.env.ICE_DEFAULT_WORK_DIR = tempDir;

    const res = await fetch(`${baseUrl}?sessionId=default`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { success: boolean; workspaceRoot: string; entries: { name: string }[] };
    expect(body.success).toBe(true);
    expect(path.resolve(body.workspaceRoot)).toBe(path.resolve(tempDir));
    expect(body.entries.map((e) => e.name)).toContain('visible');
  });

  it('GET /browse rejects path outside workspace', async () => {
    const outside = path.resolve(tempDir, '..');
    const res = await fetch(`${baseUrl}?sessionId=default&dir=${encodeURIComponent(outside)}`);
    expect(res.status).toBe(403);
  });

  it('GET /search returns fuzzy file matches', async () => {
    const res = await fetch(`${searchUrl}?sessionId=default&q=harness.ts`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { success: boolean; entries: { name: string; relativePath: string }[] };
    expect(body.success).toBe(true);
    expect(body.entries.some((e) => e.name === 'harness.ts')).toBe(true);
    expect(body.entries.some((e) => e.relativePath.includes('harness/harness.ts'))).toBe(true);
  });

  it('GET /search supports path-style fuzzy query sr/hars', async () => {
    const res = await fetch(`${searchUrl}?sessionId=default&q=${encodeURIComponent('sr/hars')}`);
    expect(res.ok).toBe(true);
    const body = await res.json() as { success: boolean; entries: { relativePath: string }[]; truncated: boolean };
    expect(body.success).toBe(true);
    expect(body.truncated).toBe(false);
    expect(body.entries.some((e) => e.relativePath.replace(/\\/g, '/').includes('harness/harness.ts'))).toBe(true);
  });
});
