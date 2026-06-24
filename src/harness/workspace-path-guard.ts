import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  extractRunCommand,
  extractToolTargetPath,
  isFileWriteTool,
} from './branch-budget-tool-path.js';
import { parseLeadingCdCommand } from '../tools/shell-cd-parser.js';
import { isUnderRoot, resolveAgainstWorkspace } from '../shared/path-scope.js';

export { isUnderRoot, resolveAgainstWorkspace } from '../shared/path-scope.js';

const WRITE_FS_OPERATIONS = new Set(['create_dir', 'delete', 'move', 'copy']);

export function pathsEqual(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** 目标路径在工作区内是否已存在于磁盘（Harness 事实对齐用）。 */
export function workspaceFileExists(workspaceRoot: string, rawPath: string | undefined): boolean {
  if (!rawPath?.trim() || !workspaceRoot.trim()) return false;
  return existsSync(resolveAgainstWorkspace(rawPath.trim(), workspaceRoot));
}

function violationMessage(
  action: string,
  rawPath: string,
  lockedRoot: string,
): string {
  return `[Workspace Lock] ${action} path "${rawPath}" is outside locked workspace ${lockedRoot}.`;
}

function checkResolvedWritePath(params: {
  rawPath: string;
  lockedRoot: string;
}): string | undefined {
  const abs = resolveAgainstWorkspace(params.rawPath, params.lockedRoot);
  if (isUnderRoot(abs, params.lockedRoot)) return undefined;
  return violationMessage('Write', params.rawPath, params.lockedRoot);
}

function extractPathArg(args: Record<string, unknown>): string | undefined {
  const raw = args.path ?? args.filePath ?? args.file_path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function extractOutsidePathsFromCommand(command: string, workspaceRoot: string): string[] {
  const outside: string[] = [];
  let scanText = command;

  const leadingCd = parseLeadingCdCommand(command);
  if (leadingCd) {
    const absCd = resolveAgainstWorkspace(leadingCd.cdPath, workspaceRoot);
    if (!isUnderRoot(absCd, workspaceRoot)) {
      outside.push(leadingCd.cdPath);
      return outside;
    }
    scanText = leadingCd.remainder;
  }

  const patterns = [
    /[A-Za-z]:[/\\][^\s"'`;&|]+/g,
    // Unix 绝对路径：至少两段或段名 ≥2 字符，排除 Windows `cd /d` 里的 `/d`
    /(?:^|\s)(\/(?:[\w.-]+\/|[\w.-]{2,})[\w./-]*)/g,
  ];
  for (const pattern of patterns) {
    for (const match of scanText.matchAll(pattern)) {
      const raw = (match[1] ?? match[0]).trim();
      const abs = resolveAgainstWorkspace(raw, workspaceRoot);
      if (!isUnderRoot(abs, workspaceRoot)) outside.push(raw);
    }
  }
  return outside;
}

function checkFsOperation(
  args: Record<string, unknown>,
  lockedRoot: string,
): string | undefined {
  const op = typeof args.operation === 'string' ? args.operation : '';
  const primary = extractPathArg(args);
  if (!primary || !WRITE_FS_OPERATIONS.has(op)) return undefined;

  const primaryViolation = checkResolvedWritePath({
    rawPath: primary,
    lockedRoot,
  });
  if (primaryViolation) return primaryViolation;

  if (typeof args.target === 'string' && args.target.trim()) {
    return checkResolvedWritePath({
      rawPath: args.target.trim(),
      lockedRoot,
    });
  }

  return undefined;
}

/**
 * 工作区锁定后的路径硬约束。返回违规则说明；undefined 表示允许。
 * 仅拦截写入与 shell 越界路径；读取（含跨盘 browse/open/parse_document 等）不拦截。
 */
export function checkWorkspacePathViolation(
  toolName: string,
  args: Record<string, unknown>,
  lockedRoot: string,
  _referenceReads: string[],
): string | undefined {
  if (!lockedRoot) return undefined;

  if (isFileWriteTool(toolName)) {
    const target = extractToolTargetPath(toolName, args);
    if (!target) return undefined;
    return checkResolvedWritePath({
      rawPath: target,
      lockedRoot,
    });
  }

  if (toolName === 'fs_operation') {
    return checkFsOperation(args, lockedRoot);
  }

  if (toolName === 'run_command') {
    const command = extractRunCommand(args);
    if (!command) return undefined;
    const outside = extractOutsidePathsFromCommand(command, lockedRoot);
    if (outside.length === 0) return undefined;
    return `[Workspace Lock] Command references paths outside locked workspace ${lockedRoot}: ${outside.join(', ')}. Run commands from the workspace root.`;
  }

  return undefined;
}
