/**
 * 工作区路径作用域（tools / harness 共用，避免 tools → harness 依赖）。
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';

export function isUnderRoot(absPath: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(absPath);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function resolveAgainstWorkspace(rawPath: string, workspaceRoot: string): string {
  return path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);
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
