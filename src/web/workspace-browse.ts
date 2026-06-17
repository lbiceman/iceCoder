/**
 * 工作区目录浏览：供聊天 @ 文件引用下拉使用。
 * 与工具层解耦，仅做安全的路径列举与默认隐藏目录过滤。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 默认隐藏的目录名（大小写不敏感） */
export const HIDDEN_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  '.git',
  '__pycache__',
  '.next',
  '.cache',
  '.vscode',
  'coverage',
  'target',
  '.gradle',
  'venv',
  '.venv',
  'site-packages',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'Pods',
  '.idea',
  '.turbo',
  '.nuxt',
  'out',
  '.svn',
  '.hg',
  'vendor',
  'build',
  '.parcel-cache',
  '.svelte-kit',
  'bower_components',
  '.yarn',
  '.pnpm-store',
]);

export interface WorkspaceBrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface WorkspaceBrowseResult {
  dir: string;
  workspaceRoot: string;
  entries: WorkspaceBrowseEntry[];
}

export function isHiddenDirName(name: string): boolean {
  return HIDDEN_DIR_NAMES.has(name.toLowerCase());
}

/** 解析并校验路径必须位于 workspaceRoot 之下（含根目录本身）。 */
export function resolvePathUnderWorkspace(
  workspaceRoot: string,
  requestedDir?: string,
): string {
  const root = path.resolve(workspaceRoot);
  if (!requestedDir || !requestedDir.trim()) {
    return root;
  }
  const candidate = path.isAbsolute(requestedDir.trim())
    ? path.resolve(requestedDir.trim())
    : path.resolve(root, requestedDir.trim());
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path outside workspace');
  }
  return candidate;
}

async function statSafe(fullPath: string): Promise<{ isDirectory: boolean } | null> {
  try {
    const stat = await fs.stat(fullPath);
    return { isDirectory: stat.isDirectory() };
  } catch {
    return null;
  }
}

/**
 * 列举目录内容；目录优先、名称排序；跳过隐藏目录与不可访问项。
 */
export async function listWorkspaceDirectory(
  workspaceRoot: string,
  requestedDir?: string,
): Promise<WorkspaceBrowseResult> {
  const dir = await resolvePathUnderWorkspace(workspaceRoot, requestedDir);
  const root = path.resolve(workspaceRoot);

  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new Error(`Directory not found: ${dir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read directory: ${msg}`);
  }

  const entries: WorkspaceBrowseEntry[] = [];

  for (const dirent of dirents) {
    const name = dirent.name;
    if (dirent.isDirectory() && isHiddenDirName(name)) continue;

    const fullPath = path.join(dir, name);
    try {
      resolvePathUnderWorkspace(root, fullPath);
    } catch {
      continue;
    }

    const info = await statSafe(fullPath);
    if (!info) continue;

    entries.push({
      name,
      path: fullPath,
      isDirectory: info.isDirectory,
    });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    dir,
    workspaceRoot: root,
    entries,
  };
}
