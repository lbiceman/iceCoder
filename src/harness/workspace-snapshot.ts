/**
 * 工作区文件快照 — Intent Checkpoint 捕获与 Restore 写回。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { CombinedCheckpointFile } from './checkpoint-engine.js';

function toPosixRel(workspaceRoot: string, absPath: string): string | null {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(absPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export function collectTrackedPathsFromCheckpoint(
  combined: CombinedCheckpointFile | null,
  extra: string[] = [],
): string[] {
  const paths = new Set<string>();
  for (const p of extra) {
    if (p?.trim()) paths.add(p.replace(/\\/g, '/'));
  }
  if (!combined) return [...paths];
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
  const root = path.resolve(workspaceRoot);
  const snapshot: Record<string, string | null> = {};

  for (const rel of trackedPaths) {
    const normalized = rel.replace(/\\/g, '/');
    const abs = path.join(root, ...normalized.split('/'));
    try {
      const stat = await fs.stat(abs);
      if (stat.isFile()) {
        snapshot[normalized] = await fs.readFile(abs, 'utf-8');
      } else {
        snapshot[normalized] = null;
      }
    } catch {
      snapshot[normalized] = null;
    }
  }
  return snapshot;
}

export async function applyWorkspaceFileSnapshot(
  workspaceRoot: string,
  snapshot: Record<string, string | null>,
  pathsToDelete: string[] = [],
): Promise<void> {
  const root = path.resolve(workspaceRoot);

  for (const rel of pathsToDelete) {
    const normalized = rel.replace(/\\/g, '/');
    const abs = path.join(root, ...normalized.split('/'));
    try {
      await fs.unlink(abs);
    } catch {
      /* may not exist */
    }
  }

  for (const [rel, content] of Object.entries(snapshot)) {
    const normalized = rel.replace(/\\/g, '/');
    const abs = path.join(root, ...normalized.split('/'));
    if (content === null) {
      try {
        await fs.unlink(abs);
      } catch {
        /* absent */
      }
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  }
}

/** 合并后续 checkpoint 中新增的路径，用于 restore 时清理 */
export function collectPathsToDeleteOnRestore(
  targetFiles: Record<string, string | null>,
  laterTrackedPaths: string[],
): string[] {
  const targetKeys = new Set(Object.keys(targetFiles));
  return laterTrackedPaths.filter((p) => !targetKeys.has(p.replace(/\\/g, '/')));
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
