/**
 * 将会话变更文件的相对路径解析到工作区，再用系统默认程序打开。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { openPathWithDefaultApp } from '../cli/open-path.js';
import { loadCheckpointIndex } from '../harness/intent-checkpoint-store.js';
import { getDefaultWorkDir } from '../cli/paths.js';
import { normalizeSessionTouchedPath } from './session-changed-files.js';
import { collectWorkspaceRoots } from './session-tool-trace-diffs.js';
import {
  assertUnderWorkspaceRoot,
  resolvePathUnderWorkspace,
} from './workspace-browse.js';

export interface OpenWorkspaceFileResult {
  ok: boolean;
  error?: string;
  absPath?: string;
}

function touchedPathKey(p: string, caseInsensitive: boolean): string {
  const n = normalizeSessionTouchedPath(p);
  return caseInsensitive ? n.toLowerCase() : n;
}

function isTouchedPathAllowed(relPath: string, touched: string[]): boolean {
  const caseInsensitive = process.platform === 'win32';
  const wanted = touchedPathKey(relPath, caseInsensitive);
  if (!wanted) return false;
  return touched.some((p) => touchedPathKey(p, caseInsensitive) === wanted);
}

export async function resolveOpenableWorkspaceFile(
  relPath: string,
  roots: string[],
): Promise<{ absPath: string } | { error: string; status: number }> {
  const normalized = normalizeSessionTouchedPath(relPath);
  if (!normalized || normalized.includes('\0')) {
    return { error: '缺少文件路径', status: 400 };
  }

  let outside = true;
  for (const root of roots) {
    let candidate: string;
    try {
      candidate = resolvePathUnderWorkspace(root, normalized);
    } catch {
      continue;
    }
    outside = false;
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(candidate);
    } catch {
      continue;
    }
    if (!st.isFile()) {
      return { error: '只能打开文件', status: 400 };
    }
    if (!(await assertUnderWorkspaceRoot(root, candidate))) {
      continue;
    }
    return { absPath: path.resolve(candidate) };
  }

  if (outside) {
    return { error: '路径不在工作区内', status: 403 };
  }
  return { error: '文件不存在或已删除', status: 404 };
}

export async function openWorkspaceChangedFile(opts: {
  sessionsDir: string;
  sessionId: string;
  relPath: string;
  defaultWorkDir?: string;
  openPath?: (absPath: string) => Promise<boolean>;
}): Promise<OpenWorkspaceFileResult & { status: number }> {
  const relPath = normalizeSessionTouchedPath(opts.relPath);
  if (!relPath) {
    return { ok: false, status: 400, error: '缺少文件路径' };
  }

  const index = await loadCheckpointIndex(opts.sessionsDir, opts.sessionId);
  if (!isTouchedPathAllowed(relPath, index.sessionTouchedPaths ?? [])) {
    return { ok: false, status: 403, error: '文件不在本会话变更列表中' };
  }

  const roots = await collectWorkspaceRoots(
    opts.sessionsDir,
    opts.sessionId,
    opts.defaultWorkDir ?? getDefaultWorkDir(),
  );
  const resolved = await resolveOpenableWorkspaceFile(relPath, roots);
  if ('error' in resolved) {
    return { ok: false, status: resolved.status, error: resolved.error };
  }

  const openPath = opts.openPath ?? openPathWithDefaultApp;
  const opened = await openPath(resolved.absPath);
  if (!opened) {
    return { ok: false, status: 500, error: '无法用系统默认程序打开' };
  }
  return { ok: true, status: 200, absPath: resolved.absPath };
}
