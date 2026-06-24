import { existsSync } from 'node:fs';

import { resolveAgainstWorkspace } from '../shared/path-scope.js';

export { isUnderRoot, resolveAgainstWorkspace } from '../shared/path-scope.js';

/** 目标路径在工作区内是否已存在于磁盘（Harness 事实对齐用）。 */
export function workspaceFileExists(workspaceRoot: string, rawPath: string | undefined): boolean {
  if (!rawPath?.trim() || !workspaceRoot.trim()) return false;
  return existsSync(resolveAgainstWorkspace(rawPath.trim(), workspaceRoot));
}
