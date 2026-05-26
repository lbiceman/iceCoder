import path from 'node:path';

import { isUnderRoot, resolveAgainstWorkspace } from './workspace-path-guard.js';

/** BranchBudget 统一使用 workspace 相对路径（POSIX `/`），合并绝对/相对重复键。 */
export function canonicalBudgetPath(
  workspaceRoot: string | undefined,
  rawPath: string | undefined | null,
): string | undefined {
  if (!rawPath?.trim()) return undefined;
  const trimmed = rawPath.trim();
  if (!workspaceRoot?.trim()) {
    return trimmed.replace(/\\/g, '/');
  }

  const abs = resolveAgainstWorkspace(trimmed, workspaceRoot);
  if (!isUnderRoot(abs, workspaceRoot)) {
    return trimmed.replace(/\\/g, '/');
  }

  const rel = path.relative(path.resolve(workspaceRoot), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return trimmed.replace(/\\/g, '/');
  }
  return rel.replace(/\\/g, '/');
}

/** checkpoint 恢复后合并同文件不同路径表示的编辑计数。 */
export function mergeBudgetPathMap(
  map: Map<string, number>,
  workspaceRoot: string,
): Map<string, number> {
  const merged = new Map<string, number>();
  for (const [rawKey, count] of map) {
    const key = canonicalBudgetPath(workspaceRoot, rawKey) ?? rawKey.replace(/\\/g, '/');
    merged.set(key, Math.max(merged.get(key) ?? 0, count));
  }
  return merged;
}

export function mergeBudgetPathSet(
  paths: Set<string>,
  workspaceRoot: string,
): Set<string> {
  const merged = new Set<string>();
  for (const raw of paths) {
    merged.add(canonicalBudgetPath(workspaceRoot, raw) ?? raw.replace(/\\/g, '/'));
  }
  return merged;
}
