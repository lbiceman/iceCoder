/**
 * 交付物类型判定 — 与 TaskIntent 解耦。
 *
 * - engineering：源码/样式白名单 → npm test / tsc / lint
 * - file_deliverable：其余一切写文件（含未知扩展名、无扩展名、脚本、数据/json/sql）→ file_info / read_file
 * - none：无写文件
 */

import type { TaskIntent, TaskStateSnapshot } from '../types/runtime-snapshot.js';
import { stripLeadingCdPrefix } from './task-acceptance-tracker.js';
import { isProjectCustomExemptPath } from './verification-exempt-config.js';

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

/**
 * 通用临时路径：tmp/temp/cache 目录段，或 .tmp/.temp/.bak / 尾随 ~ 文件名。
 * 仍会计入 filesChanged 审计，但不要求 file_info/read_file。
 */
export function isGenericTempPath(path: string): boolean {
  const norm = normalizeDeliverablePath(path);
  const segments = norm.split('/').filter(Boolean);
  const base = segments[segments.length - 1] ?? norm;
  if (/\.(tmp|temp|bak)$/.test(base)) return true;
  if (base.endsWith('~')) return true;
  // 工作区相对 tmp/、temp/（不以 /tmp/ 开头，避免与 Unix 绝对临时路径混淆）
  if (norm.startsWith('tmp/') || norm.startsWith('temp/')) return true;
  return false;
}

/**
 * 路径位于以 `.` 开头的目录之下（如 `.scratch/out.md`、`src/.cache/x.ts`）。
 * 根目录单文件（如 `.env`）不算目录豁免。
 */
export function isDotPrefixedDirPath(path: string): boolean {
  const norm = normalizeDeliverablePath(path);
  const segments = norm.split('/').filter(Boolean);
  if (segments.length < 2) return false;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (seg.startsWith('.') && seg !== '.' && seg !== '..') return true;
  }
  return false;
}

/**
 * 写后读 Gate 豁免路径。判定顺序：
 * 1. isGenericTempPath — .tmp/.bak 后缀或工作区相对 tmp/、temp/
 * 2. isDotPrefixedDirPath — 任意父级目录段以 `.` 开头
 * 3. isProjectCustomExemptPath — config.json / .icecoder.json 的 verificationExemptDirs
 */
export function isVerificationExemptPath(path: string): boolean {
  return isGenericTempPath(path)
    || isDotPrefixedDirPath(path)
    || isProjectCustomExemptPath(path);
}

/** Gate 写后须 read 确认的路径（排除临时/草稿，其余与 filesChanged 同标尺） */
export function writeConfirmationPaths(filesChanged: readonly string[]): string[] {
  return filesChanged.filter(path => !isVerificationExemptPath(path));
}

/** 写后读待确认统计（prompt / 日志用） */
export function verificationConfirmationStats(
  filesChanged: readonly string[],
  writeVersions?: Record<string, number>,
  confirmVersions?: Record<string, number>,
): { required: number; pending: number; exempt: number } {
  const requiredPaths = writeConfirmationPaths(filesChanged);
  const exempt = filesChanged.length - requiredPaths.length;
  if (requiredPaths.length === 0) {
    return { required: 0, pending: 0, exempt };
  }
  const hasWriteMaps = writeVersions && Object.keys(writeVersions).length > 0;
  if (!hasWriteMaps) {
    return { required: requiredPaths.length, pending: requiredPaths.length, exempt };
  }
  const pending = requiredPaths.filter(path => {
    const writeVer = versionForDeliverablePath(path, writeVersions);
    const confirmVer = versionForDeliverablePath(path, confirmVersions);
    return writeVer === 0 || confirmVer !== writeVer;
  }).length;
  return { required: requiredPaths.length, pending, exempt };
}

export function pathsReferToSameFile(a: string, b: string): boolean {
  return normalizeDeliverablePath(a) === normalizeDeliverablePath(b);
}

/** 从 shell 删除命令片段中提取目标路径（del / rm / Remove-Item）。 */
export function extractDeletedPathsFromCommand(command: string): string[] {
  const stripped = stripLeadingCdPrefix(command);
  const paths: string[] = [];
  const segments = stripped.split(/\s*(?:&&|\|\||;)\s*/);

  for (const segment of segments) {
    const s = segment.trim();
    if (!s) continue;

    const quotedOrBare = '(?:"([^"]+)"|\'([^\']+)\'|([^\\s>]+))';

    let match = s.match(new RegExp(`^(?:rm|rmdir)\\s+(?:(?:-[a-zA-Z]+\\s+)*)?${quotedOrBare}`, 'i'));
    if (match) {
      paths.push(match[1] ?? match[2] ?? match[3]!);
      continue;
    }

    match = s.match(new RegExp(`^(?:del|erase)\\s+(?:(?:\\/[a-zA-Z]+\\s+)*)?${quotedOrBare}`, 'i'));
    if (match) {
      paths.push(match[1] ?? match[2] ?? match[3]!);
      continue;
    }

    match = s.match(new RegExp(`^Remove-Item\\s+(?:(?:-[a-zA-Z]+\\s+)*)?${quotedOrBare}`, 'i'));
    if (match) {
      paths.push(match[1] ?? match[2] ?? match[3]!);
    }
  }

  return paths;
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
  if (writeConfirmationPaths(filesChanged).length === 0) return true;
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
