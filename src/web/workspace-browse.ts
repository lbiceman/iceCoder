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

export interface WorkspaceSearchEntry extends WorkspaceBrowseEntry {
  relativePath: string;
  score: number;
}

export interface WorkspaceBrowseResult {
  dir: string;
  workspaceRoot: string;
  entries: WorkspaceBrowseEntry[];
}

export function isHiddenDirName(name: string): boolean {
  return HIDDEN_DIR_NAMES.has(name.toLowerCase());
}

/** 跳过 dot 开头项及黑名单目录 */
export function isSkippedEntry(name: string, isDirectory: boolean): boolean {
  if (name.startsWith('.')) return true;
  if (isDirectory && isHiddenDirName(name)) return true;
  return false;
}

/** 解析 realpath 后确认仍在 workspaceRoot 内（防 symlink 逃逸） */
export async function assertUnderWorkspaceRoot(
  workspaceRoot: string,
  candidatePath: string,
): Promise<boolean> {
  try {
    const root = path.resolve(workspaceRoot);
    const resolvedRoot = await fs.realpath(root);
    const resolved = await fs.realpath(candidatePath);
    const rel = path.relative(resolvedRoot, resolved);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
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
    if (isSkippedEntry(name, dirent.isDirectory())) continue;

    const fullPath = path.join(dir, name);
    if (!(await assertUnderWorkspaceRoot(root, fullPath))) continue;

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

const SEARCH_MAX_RESULTS = 50;
const SEARCH_MAX_DEPTH = 24;
const SEARCH_MAX_SCAN = 8000;

/** 子序列模糊匹配（类似 VS Code Quick Open：顺序匹配 + 连续/边界加分） */
export function scoreFuzzySubsequence(target: string, query: string): number {
  const t = target.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 0;
  if (q.length > t.length) return 0;

  let score = 0;
  let tIdx = 0;
  let prevMatch = -2;

  for (let qIdx = 0; qIdx < q.length; qIdx++) {
    const ch = q.charAt(qIdx);
    let found = -1;
    for (let i = tIdx; i < t.length; i++) {
      if (t.charAt(i) === ch) {
        found = i;
        break;
      }
    }
    if (found < 0) return 0;

    score += 1;
    if (prevMatch === found - 1) score += 5;
    if (found === 0) score += 8;
    if (found > 0) {
      const before = t.charAt(found - 1);
      if (before === '/' || before === '\\' || before === '_' || before === '-' || before === '.') {
        score += 6;
      }
    }
    if (found > 0 && /[a-z]/.test(t.charAt(found - 1)) && /[A-Z]/.test(target.charAt(found))) {
      score += 4;
    }

    prevMatch = found;
    tIdx = found + 1;
  }

  score -= t.length * 0.02;
  return score;
}

function scoreFuzzyWithSlashes(target: string, query: string): number {
  const t = target.replace(/\\/g, '/').toLowerCase();
  const q = query.replace(/\\/g, '/').toLowerCase();
  if (!q) return 0;

  let score = 0;
  let ti = 0;
  let prev = -2;

  for (let qi = 0; qi < q.length; qi++) {
    const qc = q.charAt(qi);
    if (qc === '/') {
      let slash = -1;
      for (let i = ti; i < t.length; i++) {
        if (t.charAt(i) === '/') {
          slash = i;
          break;
        }
      }
      if (slash < 0) return 0;
      score += 4;
      ti = slash + 1;
      prev = -2;
      continue;
    }

    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t.charAt(i) === qc) {
        found = i;
        break;
      }
    }
    if (found < 0) return 0;

    score += 1;
    if (prev === found - 1) score += 5;
    if (found === 0 || (found > 0 && t.charAt(found - 1) === '/')) score += 6;
    prev = found;
    ti = found + 1;
  }

  score -= t.length * 0.02;
  return score;
}

function scorePathSegments(relativePath: string, query: string): number {
  const pathParts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  const queryParts = query.replace(/\\/g, '/').split('/').filter(Boolean);
  if (queryParts.length === 0) return 0;

  let pathIdx = 0;
  let total = 0;

  for (const qp of queryParts) {
    let best = 0;
    let bestIdx = -1;
    for (let p = pathIdx; p < pathParts.length; p++) {
      const s = scoreFuzzySubsequence(pathParts[p], qp);
      if (s > best) {
        best = s;
        bestIdx = p;
      }
    }
    if (best <= 0) return 0;
    total += best;
    pathIdx = bestIdx + 1;
  }

  return total;
}

/**
 * 路径模糊匹配：支持 sr/hars → src/harness/harness.ts
 * query 含 / 时同时尝试「分段匹配」与「整路径 + 分隔符对齐」两种策略，取较高分。
 */
export function scorePathFuzzy(relativePath: string, query: string): number {
  const path = relativePath.replace(/\\/g, '/');
  const q = query.trim().replace(/\\/g, '/');
  if (!q) return 0;

  if (q.includes('/')) {
    const segScore = scorePathSegments(path, q);
    const slashScore = scoreFuzzyWithSlashes(path, q);
    return Math.max(segScore, slashScore);
  }

  return scoreFuzzySubsequence(path, q);
}

/** @deprecated 使用 scorePathFuzzy；保留供旧测试/调用方兼容 */
export function scoreNameMatch(name: string, query: string): number {
  return scoreFuzzySubsequence(name, query);
}

export interface WorkspaceSearchResult {
  entries: WorkspaceSearchEntry[];
  truncated: boolean;
  scanned: number;
}

/**
 * 在工作区内递归搜索文件/文件夹（路径模糊匹配，类似 VS Code Quick Open）。
 * 跳过隐藏目录；结果按相关度排序并限制数量。
 */
export async function searchWorkspaceFiles(
  workspaceRoot: string,
  query: string,
  maxResults = SEARCH_MAX_RESULTS,
): Promise<WorkspaceSearchResult> {
  const root = path.resolve(workspaceRoot);
  const trimmed = query.trim();
  if (!trimmed) return { entries: [], truncated: false, scanned: 0 };

  const results: WorkspaceSearchEntry[] = [];
  let scanned = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > SEARCH_MAX_DEPTH) return;
    if (scanned >= SEARCH_MAX_SCAN) {
      truncated = true;
      return;
    }

    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const dirent of dirents) {
      if (scanned >= SEARCH_MAX_SCAN) {
        truncated = true;
        return;
      }

      const name = dirent.name;
      if (isSkippedEntry(name, dirent.isDirectory())) continue;

      const fullPath = path.join(dir, name);
      if (!(await assertUnderWorkspaceRoot(root, fullPath))) continue;

      const info = await statSafe(fullPath);
      if (!info) continue;

      scanned += 1;
      const rel = path.relative(root, fullPath).replace(/\\/g, '/');
      const score = scorePathFuzzy(rel, trimmed);
      if (score > 0) {
        results.push({
          name,
          path: fullPath,
          relativePath: rel,
          isDirectory: info.isDirectory,
          score,
        });
      }

      if (info.isDirectory) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(root, 0);

  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? 1 : -1;
    return a.relativePath.localeCompare(b.relativePath, undefined, { sensitivity: 'base' });
  });

  return {
    entries: results.slice(0, maxResults),
    truncated,
    scanned,
  };
}
