import path from 'node:path';

import { isUnderRoot, resolveAgainstWorkspace } from '../shared/path-scope.js';

/** Windows 文件系统大小写不敏感：`Src/a.ts` 与 `src/a.ts` 必须落到同一个键。 */
function platformPathKey(posixPath: string): string {
  return process.platform === 'win32' ? posixPath.toLowerCase() : posixPath;
}

/** 统一成 workspace 相对路径（POSIX `/`），让绝对/相对写法落到同一个键。 */
export function canonicalWorkspacePath(
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
