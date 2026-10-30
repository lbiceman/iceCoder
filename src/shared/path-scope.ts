/**
 * 工作区路径作用域（tools / harness 共用，避免 tools → harness 依赖）。
 */

import { existsSync, realpathSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export function isUnderRoot(absPath: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(absPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 已存在的最近祖先目录的真实路径；用于识别指向工作区外的 symlink / junction。 */
export function realpathOfNearestExisting(absPath: string): string {
  let current = absPath;
  while (true) {
    try {
      const real = realpathSync.native(current);
      return current === absPath ? real : path.join(real, path.relative(current, absPath));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absPath;
      current = parent;
    }
  }
}

export function resolveAgainstWorkspace(rawPath: string, workspaceRoot: string): string {
  return path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);
}

/** 目标路径在工作区内是否已存在于磁盘。 */
export function workspaceFileExists(workspaceRoot: string, rawPath: string | undefined): boolean {
  if (!rawPath?.trim() || !workspaceRoot.trim()) return false;
  return existsSync(resolveAgainstWorkspace(rawPath.trim(), workspaceRoot));
}

export type RipgrepSearchScope =
  | { ok: true; cwd: string; rgTarget: string }
  | { ok: false; error: string };

/**
 * 解析 glob/grep 的搜索根：目录原样；若 path 指向文件则用其所在目录，rg 目标为该文件。
 * 允许绝对路径或相对路径解析到 workDir 外（读取不限制跨目录/跨盘）。
 */
export async function resolveRipgrepSearchScope(
  workDir: string,
  rawPath?: string,
): Promise<RipgrepSearchScope> {
  const base = path.resolve(workDir);
  const raw = rawPath?.trim();
  const resolved = !raw || raw === '.'
    ? base
    : resolveAgainstWorkspace(raw, base);

  try {
    const st = await stat(resolved);
    if (st.isFile()) {
      return {
        ok: true,
        cwd: path.dirname(resolved),
        rgTarget: path.basename(resolved),
      };
    }
    if (st.isDirectory()) {
      return { ok: true, cwd: resolved, rgTarget: '.' };
    }
  } catch {
    /* 路径不存在：按目录交给 rg，由 rg 返回无匹配或错误 */
  }

  return { ok: true, cwd: resolved, rgTarget: '.' };
}
