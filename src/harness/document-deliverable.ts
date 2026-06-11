/**
 * 交付物类型判定 — 与 TaskIntent 解耦。
 *
 * - engineering：源码/样式白名单 → 收尾 Gate 提示跑单元测试
 * - file_deliverable：其余一切写文件（含未知扩展名、无扩展名、脚本、数据/json/sql）
 * - none：无写文件
 */

import type { ToolResult } from '../tools/types.js';
import type { TaskIntent, TaskStateSnapshot, VerificationStatus } from '../types/runtime-snapshot.js';
import { stripLeadingCdPrefix } from './task-acceptance-tracker.js';
import { isProjectCustomExemptPath } from './verification-exempt-config.js';
import { workspaceFileExists } from './workspace-path-guard.js';

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

/** Gate 单测提示目标：工程源码，不含纯样式扩展名 */
export function isEngineeringUnitTestTargetPath(path: string): boolean {
  return isEngineeringDeliverablePath(path);
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
  // 工作区相对 tmp/、temp/、cache/（不以 /tmp/ 开头，避免与 Unix 绝对临时路径混淆）
  if (norm.startsWith('tmp/') || norm.startsWith('temp/') || norm.startsWith('cache/')) return true;
  return false;
}

/**
 * 一次性诊断/验证脚本（如 check-*.ps1、cleanup.ps1），仍记入 filesChanged 审计，但豁免单测 Gate。
 */
export function isEphemeralScriptPath(path: string): boolean {
  const norm = normalizeDeliverablePath(path);
  const base = norm.split('/').filter(Boolean).pop() ?? norm;
  const dot = base.lastIndexOf('.');
  const name = dot > 0 ? base.slice(0, dot) : base;
  if (/^(verify|check|fresh|elevate|probe|temp|scratch|cleanup)([-_.]|$)/i.test(name)) return true;
  if (/-(test|probe|temp|scratch)$/i.test(name)) return true;
  return false;
}

/** 工具结果是否表明目标路径不存在（ENOENT / file not found）。 */
export function isMissingFileToolResult(result: ToolResult): boolean {
  if (result.success) return false;
  const text = `${result.error ?? ''} ${result.output ?? ''}`;
  return /\benoent\b/i.test(text)
    || /no such file or directory/i.test(text)
    || /file not found/i.test(text)
    || /找不到文件|文件不存在/.test(text);
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
    || isEphemeralScriptPath(path)
    || isDotPrefixedDirPath(path)
    || isProjectCustomExemptPath(path);
}

/** 变更列表是否全部为 Gate 豁免路径（记忆 / session-notes 等） */
export function areAllVerificationExemptPaths(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(isVerificationExemptPath);
}

/** 磁盘上已不存在的 filesChanged 路径（清理/删除后同步 Gate 用）。 */
export function missingChangedFilePaths(
  filesChanged: readonly string[],
  workspaceRoot?: string,
  writeVersions?: Record<string, number>,
  confirmVersions?: Record<string, number>,
): string[] {
  if (!workspaceRoot?.trim() || filesChanged.length === 0) return [];
  return filesChanged.filter(path => {
    if (workspaceFileExists(workspaceRoot, path)) return false;
    if (writeVersions) {
      const writeVer = versionForDeliverablePath(path, writeVersions);
      const confirmVer = versionForDeliverablePath(path, confirmVersions);
      // 写后读 pending：即使磁盘暂未可见也不从 filesChanged 剔除（避免 mock/落盘延迟误清）
      if (writeVer > 0 && confirmVer !== writeVer) return false;
    }
    return true;
  });
}

/** Gate 写后须 read 确认的路径（排除临时/草稿，其余与 filesChanged 同标尺） */
export function writeConfirmationPaths(filesChanged: readonly string[]): string[] {
  return filesChanged.filter(path => !isVerificationExemptPath(path));
}

/**
 * 门控实际待确认路径：在 writeConfirmationPaths 基础上排除磁盘已不存在的文件。
 * 写后读 pending（writeVersion>0 且 confirm≠write）始终保留，避免落盘延迟/mock 绕过 Gate。
 * 已确认后磁盘不存在的路径排除（cleanup/删除后不再要求 read_file/file_info）。
 */
export function gateConfirmationPaths(
  filesChanged: readonly string[],
  workspaceRoot?: string,
  writeVersions?: Record<string, number>,
  confirmVersions?: Record<string, number>,
): string[] {
  const paths = writeConfirmationPaths(filesChanged);
  if (!workspaceRoot?.trim()) return paths;
  return paths.filter(path => {
    if (writeVersions) {
      const writeVer = versionForDeliverablePath(path, writeVersions);
      const confirmVer = versionForDeliverablePath(path, confirmVersions);
      if (writeVer > 0 && confirmVer !== writeVer) return true;
      if (writeVer > 0 && confirmVer === writeVer) return false;
    }
    return workspaceFileExists(workspaceRoot, path);
  });
}

/** 写后读待确认统计（prompt / 日志用） */
export function verificationConfirmationStats(
  filesChanged: readonly string[],
  writeVersions?: Record<string, number>,
  confirmVersions?: Record<string, number>,
  workspaceRoot?: string,
): { required: number; pending: number; exempt: number } {
  const requiredPaths = gateConfirmationPaths(filesChanged, workspaceRoot, writeVersions, confirmVersions);
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

/** 参与单元测试 Gate 提示的工程源码路径（排除 temp/dot-dir/豁免路径） */
export function engineeringTestTargetPaths(filesChanged: readonly string[]): string[] {
  return filesChanged.filter(
    path => isEngineeringUnitTestTargetPath(path) && !isVerificationExemptPath(path),
  );
}

export function hasEngineeringTestTargets(filesChanged: readonly string[]): boolean {
  return engineeringTestTargetPaths(filesChanged).length > 0;
}

/** 收尾时应 inject「请跑单元测试」（工程变更且尚未跑过验收命令） */
export function shouldPromptEngineeringUnitTest(
  filesChanged: readonly string[],
  verificationStatus: VerificationStatus,
): boolean {
  if (!hasEngineeringTestTargets(filesChanged)) return false;
  return verificationStatus === 'required';
}

/** 单测已跑但失败：仅加强提示，不 hard block */
export function shouldInjectFailedUnitTestReminder(
  filesChanged: readonly string[],
  verificationStatus: VerificationStatus,
): boolean {
  if (!hasEngineeringTestTargets(filesChanged)) return false;
  return verificationStatus === 'failed';
}

/**
 * Gate 是否具备验收所需工具。
 * - Acceptance Gate pending → run_command
 * - 工程变更待跑单测 → run_command
 */
export function canVerifyDeliverableKind(
  filesChanged: readonly string[],
  toolNames: readonly string[],
  acceptanceIncomplete?: boolean,
  verificationStatus: VerificationStatus = 'not_required',
): boolean {
  if (acceptanceIncomplete) {
    return toolNames.some(name => name === 'run_command');
  }
  if (shouldPromptEngineeringUnitTest(filesChanged, verificationStatus)) {
    return toolNames.some(name => name === 'run_command');
  }
  return true;
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
  workspaceRoot?: string,
): boolean {
  const paths = gateConfirmationPaths(filesChanged, workspaceRoot, writeVersions, confirmVersions);
  if (paths.length === 0) return false;

  const hasWriteMaps = writeVersions && Object.keys(writeVersions).length > 0;
  if (!hasWriteMaps) return true;

  return paths.some(path => {
    const writeVer = versionForDeliverablePath(path, writeVersions);
    const confirmVer = versionForDeliverablePath(path, confirmVersions);
    return writeVer === 0 || confirmVer !== writeVer;
  });
}

export function snapshotHasUnconfirmedFileDeliverables(
  task: TaskStateSnapshot,
  workspaceRoot?: string,
): boolean {
  return hasUnconfirmedFileDeliverables(
    task.filesChanged,
    task.fileDeliverableWriteVersions,
    task.fileDeliverableConfirmVersions,
    workspaceRoot,
  );
}

/** file_info 成功结果是否表明目标为可读文件（含 0 字节占位文件） */
export function isNonEmptyFileInfoOutput(output: string | undefined): boolean {
  if (!output?.trim()) return false;
  try {
    const parsed = JSON.parse(output) as { size?: unknown; type?: unknown };
    if (parsed.type === 'directory') return false;
    if (typeof parsed.size === 'number') return parsed.size >= 0;
  } catch {
    // 非 JSON 但调用成功时仍视为已确认
  }
  return true;
}

/** read_file 成功即可确认存在（允许空文件内容） */
export function isNonEmptyReadOutput(output: string | undefined): boolean {
  return output !== undefined && output !== null;
}

/** 从版本 Map 查路径版本（与 versionForDeliverablePath 同标尺，支持非归一化键） */
export function deliverableVersionFromMap(
  versions: Map<string, number> | Record<string, number> | undefined,
  path: string,
): number {
  if (!versions) return 0;
  if (!(versions instanceof Map)) {
    return versionForDeliverablePath(path, versions);
  }
  const norm = normalizeDeliverablePath(path);
  if (versions.has(norm)) return versions.get(norm)!;
  for (const [key, ver] of versions) {
    if (pathsReferToSameFile(key, path)) return ver;
  }
  return 0;
}

/** Gate / prompt 用：仍待写后确认的路径列表 */
export function listPendingConfirmationPaths(
  filesChanged: readonly string[],
  writeVersions?: Record<string, number>,
  confirmVersions?: Record<string, number>,
  workspaceRoot?: string,
): string[] {
  const paths = gateConfirmationPaths(filesChanged, workspaceRoot, writeVersions, confirmVersions);
  return paths.filter(path => {
    const writeVer = versionForDeliverablePath(path, writeVersions);
    const confirmVer = versionForDeliverablePath(path, confirmVersions);
    return writeVer === 0 || confirmVer !== writeVer;
  });
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
