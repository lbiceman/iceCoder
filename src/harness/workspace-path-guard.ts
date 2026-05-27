import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  extractRunCommand,
  extractToolTargetPath,
  isFileWriteTool,
} from './branch-budget-tool-path.js';
import { parseLeadingCdCommand } from '../tools/shell-cd-parser.js';

const READ_PATH_TOOLS = new Set([
  'read_file',
  'parse_document',
  'open_file',
  'image_read',
  'notebook_read',
  'doc_parse',
  'grep_file',
  'file_info',
  'parse_xmind_deep',
  'parse_pptx_deep',
  'parse_doc_legacy',
  'parse_xlsx_deep',
  'diff_files',
]);

const WRITE_FS_OPERATIONS = new Set(['create_dir', 'delete', 'move', 'copy']);

const READ_FS_OPERATIONS = new Set(['list']);

export function pathsEqual(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

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

/** 目标路径在工作区内是否已存在于磁盘（Harness 事实对齐用）。 */
export function workspaceFileExists(workspaceRoot: string, rawPath: string | undefined): boolean {
  if (!rawPath?.trim() || !workspaceRoot.trim()) return false;
  return existsSync(resolveAgainstWorkspace(rawPath.trim(), workspaceRoot));
}

function isAllowedReferenceRead(
  absPath: string,
  referenceReads: string[],
): boolean {
  return referenceReads.some((ref) => pathsEqual(absPath, ref));
}

function violationMessage(
  action: string,
  rawPath: string,
  lockedRoot: string,
  referenceReads: string[],
): string {
  const refHint = referenceReads.length > 0
    ? ` Allowed reference reads: ${referenceReads.join(', ')}.`
    : '';
  return `[Workspace Lock] ${action} path "${rawPath}" is outside locked workspace ${lockedRoot}.${refHint}`;
}

function checkResolvedPath(params: {
  rawPath: string;
  lockedRoot: string;
  referenceReads: string[];
  write: boolean;
}): string | undefined {
  const abs = resolveAgainstWorkspace(params.rawPath, params.lockedRoot);
  if (isUnderRoot(abs, params.lockedRoot)) return undefined;
  if (!params.write && isAllowedReferenceRead(abs, params.referenceReads)) return undefined;
  return violationMessage(
    params.write ? 'Write' : 'Read',
    params.rawPath,
    params.lockedRoot,
    params.referenceReads,
  );
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
  referenceReads: string[],
): string | undefined {
  const op = typeof args.operation === 'string' ? args.operation : '';
  const primary = extractPathArg(args);
  if (!primary) return undefined;

  const isWrite = WRITE_FS_OPERATIONS.has(op);
  const isRead = READ_FS_OPERATIONS.has(op);
  if (!isWrite && !isRead) return undefined;

  const primaryViolation = checkResolvedPath({
    rawPath: primary,
    lockedRoot,
    referenceReads,
    write: isWrite,
  });
  if (primaryViolation) return primaryViolation;

  if (isWrite && typeof args.target === 'string' && args.target.trim()) {
    return checkResolvedPath({
      rawPath: args.target.trim(),
      lockedRoot,
      referenceReads,
      write: true,
    });
  }

  return undefined;
}

function checkDiffFiles(
  args: Record<string, unknown>,
  lockedRoot: string,
  referenceReads: string[],
): string | undefined {
  for (const key of ['pathA', 'pathB', 'fileA', 'fileB']) {
    const raw = args[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const violation = checkResolvedPath({
      rawPath: raw.trim(),
      lockedRoot,
      referenceReads,
      write: false,
    });
    if (violation) return violation;
  }
  return undefined;
}

/**
 * 工作区锁定后的路径硬约束。返回违规则说明；undefined 表示允许。
 */
export function checkWorkspacePathViolation(
  toolName: string,
  args: Record<string, unknown>,
  lockedRoot: string,
  referenceReads: string[],
): string | undefined {
  if (!lockedRoot) return undefined;

  if (isFileWriteTool(toolName)) {
    const target = extractToolTargetPath(toolName, args);
    if (!target) return undefined;
    return checkResolvedPath({
      rawPath: target,
      lockedRoot,
      referenceReads,
      write: true,
    });
  }

  if (toolName === 'fs_operation') {
    return checkFsOperation(args, lockedRoot, referenceReads);
  }

  if (toolName === 'browse_directory') {
    const target = extractPathArg(args);
    if (!target) return undefined;
    return checkResolvedPath({
      rawPath: target,
      lockedRoot,
      referenceReads,
      write: false,
    });
  }

  if (toolName === 'list_drives') {
    return `[Workspace Lock] list_drives is disabled while workspace is locked to ${lockedRoot}. Use fs_operation/list or relative paths within the workspace.`;
  }

  if (toolName === 'search_codebase' && typeof args.directory === 'string' && args.directory.trim()) {
    const dir = args.directory.trim();
    if (path.isAbsolute(dir)) {
      return checkResolvedPath({
        rawPath: dir,
        lockedRoot,
        referenceReads,
        write: false,
      });
    }
  }

  if (READ_PATH_TOOLS.has(toolName)) {
    if (toolName === 'diff_files') {
      return checkDiffFiles(args, lockedRoot, referenceReads);
    }
    const target = extractPathArg(args);
    if (!target) return undefined;
    return checkResolvedPath({
      rawPath: target,
      lockedRoot,
      referenceReads,
      write: false,
    });
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
