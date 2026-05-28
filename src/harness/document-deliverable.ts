/**
 * 交付物类型判定 — 与 TaskIntent 解耦。
 *
 * - engineering：源码/样式白名单 → npm test / tsc / lint
 * - file_deliverable：其余一切写文件（含未知扩展名、无扩展名、脚本、数据/json/sql）→ file_info / read_file
 * - none：无写文件
 */

import type { TaskIntent, VerificationStatus } from '../types/runtime-snapshot.js';

export type DeliverableKind = 'file_deliverable' | 'engineering' | 'none';

/** 含任一即走工程验收；json/yaml/sql 等配置/数据扩展名不在此列（单独修改时用 file_info 验收） */
const ENGINEERING_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'rb',
  'php',
  'css',
  'scss',
  'less',
  'wasm',
]);

const FILE_DELIVERABLE_CONFIRM_TOOLS = new Set(['file_info', 'read_file', 'open_file']);

export function normalizeDeliverablePath(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

function fileExtension(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

export function isEngineeringDeliverablePath(path: string): boolean {
  const ext = fileExtension(path);
  return ext.length > 0 && ENGINEERING_EXTENSIONS.has(ext);
}

/**
 * 变更列表为空 → none；含工程白名单扩展名 → engineering；否则 → file_deliverable。
 */
export function classifyChangedFiles(filesChanged: readonly string[]): DeliverableKind {
  if (filesChanged.length === 0) return 'none';
  if (filesChanged.some(isEngineeringDeliverablePath)) return 'engineering';
  return 'file_deliverable';
}

/** file_deliverable 模式下需写后确认的全部路径 */
export function fileDeliverablePaths(filesChanged: readonly string[]): string[] {
  if (classifyChangedFiles(filesChanged) !== 'file_deliverable') return [];
  return filesChanged.filter(file => !isEngineeringDeliverablePath(file));
}

export function pathsReferToSameFile(a: string, b: string): boolean {
  return normalizeDeliverablePath(a) === normalizeDeliverablePath(b);
}

export function isFileDeliverableConfirmationTool(toolName: string): boolean {
  return FILE_DELIVERABLE_CONFIRM_TOOLS.has(toolName);
}

export function canVerifyDeliverableKind(
  kind: DeliverableKind,
  toolNames: readonly string[],
  verificationStatus: VerificationStatus = 'not_required',
): boolean {
  const hasRunCommand = toolNames.some(name => name === 'run_command');
  const hasFileConfirm = toolNames.some(name => FILE_DELIVERABLE_CONFIRM_TOOLS.has(name));

  if (kind === 'file_deliverable') return hasFileConfirm;
  if (kind === 'engineering') return hasRunCommand;
  if (verificationStatus === 'required' || verificationStatus === 'failed') {
    return hasRunCommand;
  }
  return false;
}

/** file_info 成功结果是否表明非空文件 */
export function isNonEmptyFileInfoOutput(output: string | undefined): boolean {
  if (!output?.trim()) return false;
  try {
    const parsed = JSON.parse(output) as { size?: unknown; type?: unknown };
    if (parsed.type === 'directory') return false;
    if (typeof parsed.size === 'number') return parsed.size > 0;
  } catch {
    // 非 JSON 但调用成功时仍视为已确认
  }
  return true;
}

export function isNonEmptyReadOutput(output: string | undefined): boolean {
  return (output?.trim().length ?? 0) > 0;
}

/** 任务目标或已变更文件表明为文件交付类（stop hook 减负） */
export function isFileDeliverableOrientedTask(
  goal: string,
  filesChanged: readonly string[],
): boolean {
  if (classifyChangedFiles(filesChanged) === 'file_deliverable') return true;
  if (filesChanged.length > 0) return false;
  return hasUnfulfilledFileDeliverableGoal(goal, filesChanged);
}

/** 目标要求写文件交付物但尚未写入（拦截无交付物早停） */
export function hasUnfulfilledFileDeliverableGoal(
  goal: string,
  filesChanged: readonly string[] = [],
  intent?: TaskIntent,
): boolean {
  if (filesChanged.length > 0) return false;
  if (intent === 'question' || intent === 'inspect') return false;

  const g = goal.trim();
  if (!g) return false;

  if (/整理.*(?:md|文档)|写成.*(?:文档|md|file)|生成.*(?:文档|md|file)|输出.*文件|导出.*文件|保存.*文件|放到/i.test(g)) {
    return true;
  }

  const hasFileNoun = /readme|文档|markdown|\.md\b|docx|\.pdf\b|pptx|xlsx|\.txt\b|\bfile\b/i.test(g);
  const hasWriteVerb = /写|生成|整理|放到|保存|导出|输出|write|save|export|create|put/i.test(g);
  return hasFileNoun && hasWriteVerb;
}
