/**
 * 交付物类型判定 — 与 TaskIntent 解耦。
 *
 * - engineering：源码/样式白名单 → npm test / tsc / lint
 * - file_deliverable：其余一切写文件（含未知扩展名、无扩展名、脚本、数据/json/sql）→ file_info / read_file
 * - none：无写文件
 */

import type { TaskIntent, TaskStateSnapshot } from '../types/runtime-snapshot.js';

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

/** 需 file_info/read_file 写后确认的非工程路径（交付物分类 / 文案用） */
export function fileDeliverablePaths(filesChanged: readonly string[]): string[] {
  return filesChanged.filter(file => !isEngineeringDeliverablePath(file));
}

/** Gate 写后须 read 确认的全部路径（含 .java/.py/.ts 等，与 filesChanged 一致） */
export function writeConfirmationPaths(filesChanged: readonly string[]): string[] {
  return [...filesChanged];
}

export function pathsReferToSameFile(a: string, b: string): boolean {
  return normalizeDeliverablePath(a) === normalizeDeliverablePath(b);
}

export function isFileDeliverableConfirmationTool(toolName: string): boolean {
  return FILE_DELIVERABLE_CONFIRM_TOOLS.has(toolName);
}

/**
 * Gate 是否具备验收所需工具。
 * - Acceptance Gate pending → run_command
 * - 有未写后确认的变更文件 → file_info / read_file
 */
export function canVerifyDeliverableKind(
  filesChanged: readonly string[],
  toolNames: readonly string[],
  acceptanceIncomplete?: boolean,
): boolean {
  if (acceptanceIncomplete) {
    return toolNames.some(name => name === 'run_command');
  }
  if (filesChanged.length === 0) return true;
  return toolNames.some(name => FILE_DELIVERABLE_CONFIRM_TOOLS.has(name));
}

/** 在版本 Map 中查找路径对应的版本号（兼容归一化键与原始路径） */
export function versionForDeliverablePath(
  path: string,
  versions: Record<string, number> | undefined,
): number {
  if (!versions) return 0;
  const norm = normalizeDeliverablePath(path);
  if (versions[norm] !== undefined) return versions[norm]!;
  for (const [key, ver] of Object.entries(versions)) {
    if (pathsReferToSameFile(key, path)) return ver;
  }
  return 0;
}

/**
 * 是否存在尚未写后确认的变更文件（与 TaskState.areAllFileDeliverablesConfirmed 同标尺）。
 * 无版本 Map 时保守视为 pending（兼容旧 checkpoint）。
 */
export function hasUnconfirmedFileDeliverables(
  filesChanged: readonly string[],
  writeVersions?: Record<string, number>,
  confirmVersions?: Record<string, number>,
): boolean {
  const paths = writeConfirmationPaths(filesChanged);
  if (paths.length === 0) return false;

  const hasWriteMaps = writeVersions && Object.keys(writeVersions).length > 0;
  if (!hasWriteMaps) return true;

  return paths.some(path => {
    const writeVer = versionForDeliverablePath(path, writeVersions);
    const confirmVer = versionForDeliverablePath(path, confirmVersions);
    return writeVer === 0 || confirmVer !== writeVer;
  });
}

export function snapshotHasUnconfirmedFileDeliverables(task: TaskStateSnapshot): boolean {
  return hasUnconfirmedFileDeliverables(
    task.filesChanged,
    task.fileDeliverableWriteVersions,
    task.fileDeliverableConfirmVersions,
  );
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
