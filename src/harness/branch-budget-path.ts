import path from 'node:path';

import { isUnderRoot, resolveAgainstWorkspace } from '../shared/path-scope.js';

/** Windows 文件系统大小写不敏感：`Src/a.ts` 与 `src/a.ts` 必须落到同一个键。 */
function platformPathKey(posixPath: string): string {
  return process.platform === 'win32' ? posixPath.toLowerCase() : posixPath;
}

/** BranchBudget 统一使用 workspace 相对路径（POSIX `/`），合并绝对/相对重复键。 */
export function canonicalBudgetPath(
  workspaceRoot: string | undefined,
  rawPath: string | undefined | null,
): string | undefined {
  if (!rawPath?.trim()) return undefined;
  const trimmed = rawPath.trim();
  if (!workspaceRoot?.trim()) {
    return platformPathKey(trimmed.replace(/\\/g, '/'));
  }

  const abs = resolveAgainstWorkspace(trimmed, workspaceRoot);
  if (!isUnderRoot(abs, workspaceRoot)) {
    return platformPathKey(trimmed.replace(/\\/g, '/'));
  }

  const rel = path.relative(path.resolve(workspaceRoot), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return platformPathKey(trimmed.replace(/\\/g, '/'));
  }
  return platformPathKey(rel.replace(/\\/g, '/'));
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

const FILE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'patch_file',
  'batch_edit_file',
]);

/** 从 write/edit 类工具参数中提取目标文件路径。 */
export function extractToolTargetPath(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!FILE_WRITE_TOOLS.has(toolName)) return undefined;
  const raw = args.path ?? args.file_path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** 从 run_command 参数中提取命令字符串。 */
export function extractRunCommand(args: Record<string, unknown>): string | undefined {
  const raw = args.command ?? args.cmd;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

export function isFileWriteTool(toolName: string): boolean {
  return FILE_WRITE_TOOLS.has(toolName);
}
