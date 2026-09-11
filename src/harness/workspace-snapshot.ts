/**
 * 工作区文件快照 — Intent Checkpoint 捕获与 Restore 写回。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { CombinedCheckpointFile } from './checkpoint-engine.js';
import type { ProjectCheckpointV3 } from '../types/runtime-checkpoint.js';

function toPosixRel(workspaceRoot: string, absPath: string): string | null {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(absPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function stripRedundantWorkspacePrefix(root: string, posixRel: string): string {
  const rootParts = path.resolve(root).replace(/\\/g, '/').split('/').filter(Boolean);
  const pathParts = posixRel.split('/').filter(Boolean);
  if (pathParts.length < 2) return posixRel;
  const max = Math.min(rootParts.length, pathParts.length - 1);
  const basename = (rootParts[rootParts.length - 1] || '').toLowerCase();
  for (let n = max; n >= 1; n--) {
    if (n === 1 && pathParts[0].toLowerCase() !== basename) continue;
    const tail = rootParts.slice(-n).join('/');
    const head = pathParts.slice(0, n).join('/');
    if (tail.toLowerCase() !== head.toLowerCase()) continue;
    const rest = pathParts.slice(n).join('/');
    if (rest) return rest;
  }
  return posixRel;
}

/**
 * 把工具/归档里的路径收成「相对当前工作区根」的 POSIX 路径。
 * 锁定子目录后，模型常给出带父级前缀的 path（如 test/agentToolTest/20260910/empty.txt），
 * 直接 join 会删错套娃路径，真正的 empty.txt 还在根上。
 */
export function remapPathToWorkspace(workspaceRoot: string, storedPath: string): string | null {
  const raw = String(storedPath || '').trim();
  if (!raw) return null;
  const root = path.resolve(workspaceRoot);
  const posix = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  const looksAbs = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
  const abs = looksAbs ? path.resolve(raw) : path.resolve(root, posix);
  const inside = toPosixRel(root, abs);
  const stripped = stripRedundantWorkspacePrefix(root, posix);
  if (stripped !== posix) {
    const strippedRel = toPosixRel(root, path.resolve(root, stripped));
    if (strippedRel) return strippedRel;
  }
  return inside ?? posix;
}

export function remapSnapshotToWorkspace(
  workspaceRoot: string,
  snapshot: Record<string, string | null>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [raw, content] of Object.entries(snapshot)) {
    const key = remapPathToWorkspace(workspaceRoot, raw) ?? raw.replace(/\\/g, '/');
    if (!(key in out) || content === null) out[key] = content;
  }
  return out;
}

function absInWorkspace(workspaceRoot: string, storedPath: string): string {
  const rel = remapPathToWorkspace(workspaceRoot, storedPath)
    ?? storedPath.replace(/\\/g, '/');
  return path.resolve(path.resolve(workspaceRoot), rel);
}

export function collectTrackedPathsFromCheckpoint(
  combined: CombinedCheckpointFile | ProjectCheckpointV3 | null,
  extra: string[] = [],
): string[] {
  const paths = new Set<string>();
  for (const p of extra) {
    if (p?.trim()) paths.add(p.replace(/\\/g, '/'));
  }
  if (!combined) return [...paths];
  if (combined.version === 3) {
    for (const p of combined.execution.taskState.filesChanged) paths.add(p.replace(/\\/g, '/'));
    for (const p of combined.execution.taskState.filesRead) paths.add(p.replace(/\\/g, '/'));
    for (const p of combined.workspace.repoContext.filesChanged) paths.add(p.replace(/\\/g, '/'));
    for (const p of combined.workspace.repoContext.filesRead) paths.add(p.replace(/\\/g, '/'));
    return [...paths];
  }
  for (const p of combined.taskState?.filesChanged ?? []) paths.add(p.replace(/\\/g, '/'));
  for (const p of combined.taskState?.filesRead ?? []) paths.add(p.replace(/\\/g, '/'));
  for (const p of combined.repoContext?.filesChanged ?? []) paths.add(p.replace(/\\/g, '/'));
  for (const p of combined.repoContext?.filesRead ?? []) paths.add(p.replace(/\\/g, '/'));
  return [...paths];
}

export function mergeTrackedPathSets(...groups: string[][]): string[] {
  const paths = new Set<string>();
  for (const group of groups) {
    for (const p of group) {
      if (p?.trim()) paths.add(p.replace(/\\/g, '/'));
    }
  }
  return [...paths];
}

/** 捕获 restore 前工作区文件状态（用于 rollback） */
export async function captureWorkspaceFilesForPaths(
  workspaceRoot: string,
  paths: string[],
): Promise<Record<string, string | null>> {
  return captureWorkspaceFileSnapshot(workspaceRoot, paths);
}

export async function captureWorkspaceFileSnapshot(
  workspaceRoot: string,
  trackedPaths: string[],
): Promise<Record<string, string | null>> {
  const snapshot: Record<string, string | null> = {};

  for (const rel of trackedPaths) {
    const key = remapPathToWorkspace(workspaceRoot, rel) ?? rel.replace(/\\/g, '/');
    const abs = absInWorkspace(workspaceRoot, key);
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) {
        snapshot[key] = await fs.readFile(abs, 'utf-8');
      } else {
        snapshot[key] = null;
      }
    } catch {
      snapshot[key] = null;
    }
  }
  return snapshot;
}

export async function applyWorkspaceFileSnapshot(
  workspaceRoot: string,
  snapshot: Record<string, string | null>,
  pathsToDelete: string[] = [],
): Promise<void> {
  const unlinkRel = async (rel: string) => {
    const abs = absInWorkspace(workspaceRoot, rel);
    try {
      await fs.unlink(abs);
    } catch {
      /* may not exist */
    }
  };

  for (const rel of pathsToDelete) {
    await unlinkRel(rel);
  }

  const remapped = remapSnapshotToWorkspace(workspaceRoot, snapshot);
  for (const [rel, content] of Object.entries(remapped)) {
    const abs = absInWorkspace(workspaceRoot, rel);
    if (content === null) {
      await unlinkRel(rel);
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  }
}

/**
 * 检查点当时还不存在的路径才进入删除列表。
 * 快照里已有内容（含空文件）必须写回，不能因为会话后来碰过就删掉。
 */
export function collectPathsToDeleteOnRestore(
  targetFiles: Record<string, string | null>,
  laterCreatedPaths: string[],
  workspaceRoot?: string,
): string[] {
  const remap = (raw: string) =>
    workspaceRoot
      ? (remapPathToWorkspace(workspaceRoot, raw) ?? raw.replace(/\\/g, '/'))
      : raw.replace(/\\/g, '/');
  const existedKeys = new Set(
    Object.entries(targetFiles)
      .filter(([, content]) => content !== null)
      .map(([raw]) => remap(raw)),
  );
  const extra: string[] = [];
  const seen = new Set<string>();
  for (const raw of laterCreatedPaths) {
    const p = remap(raw);
    if (!p || existedKeys.has(p) || seen.has(p)) continue;
    seen.add(p);
    extra.push(p);
  }
  return extra;
}

export function absolutizeIfNeeded(workspaceRoot: string, filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.join(workspaceRoot, filePath);
}

export { toPosixRel };

const LIKELY_FILE_PATH_RE =
  /(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|css|scss|less|html|json|md|py|rs|go|yaml|yml|toml|xml|svg|vue|svelte|txt|ts|js))(?:\b|$)/gi;

/** 从用户消息文本中提取可能涉及的相对文件路径（如 tokens.css、src/foo.ts）。 */
export function extractLikelyFilePathsFromText(text: string): string[] {
  if (!text?.trim()) return [];
  const paths = new Set<string>();
  for (const m of text.matchAll(/#([^\s#]+\.(?:md|tsx?|jsx?|css|json|py|rs|go))/gi)) {
    if (m[1]) paths.add(m[1].replace(/\\/g, '/'));
  }
  let match: RegExpExecArray | null;
  const re = new RegExp(LIKELY_FILE_PATH_RE.source, LIKELY_FILE_PATH_RE.flags);
  while ((match = re.exec(text)) !== null) {
    if (match[1]) paths.add(match[1].replace(/\\/g, '/'));
  }
  return [...paths];
}

async function findFileByBasename(
  workspaceRoot: string,
  basename: string,
  maxDepth = 8,
): Promise<string | null> {
  const root = path.resolve(workspaceRoot);
  const target = basename.toLowerCase();
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === target) {
        return abs;
      }
      if (entry.isDirectory()) {
        queue.push({ dir: abs, depth: depth + 1 });
      }
    }
  }
  return null;
}

/** 将消息里提到的路径解析为工作区相对路径。 */
export async function resolveLikelyPathsInWorkspace(
  workspaceRoot: string,
  candidates: string[],
): Promise<string[]> {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const c = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!c) continue;
    let rel = c;
    if (!c.includes('/')) {
      const abs = await findFileByBasename(workspaceRoot, c);
      if (!abs) continue;
      const posix = toPosixRel(workspaceRoot, abs);
      if (!posix) continue;
      rel = posix;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    resolved.push(rel);
  }
  return resolved;
}
