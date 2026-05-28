/**
 * 交付物类型判定 — 与 TaskIntent 解耦。
 *
 * - engineering：工程源码/配置白名单 → npm test / tsc / lint
 * - file_deliverable：其余一切写文件（含未知扩展名、无扩展名、脚本）→ file_info / read_file
 * - none：无写文件
 */

export type DeliverableKind = 'file_deliverable' | 'engineering' | 'none';

/** @deprecated 使用 {@link DeliverableKind} 的 file_deliverable */
export type LegacyDocumentKind = 'document';

/** 含任一即走工程验收；shell 脚本不在此列，走 file_deliverable */
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
  'sql',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
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
 * 未知扩展名、无扩展名（LICENSE/Makefile）一律 file_deliverable。
 */
export function classifyChangedFiles(filesChanged: readonly string[]): DeliverableKind {
  if (filesChanged.length === 0) return 'none';
  if (filesChanged.some(isEngineeringDeliverablePath)) return 'engineering';
  return 'file_deliverable';
}

/** file_deliverable 模式下需写后确认的全部路径（非 engineering 的 filesChanged） */
export function fileDeliverablePaths(filesChanged: readonly string[]): string[] {
  if (classifyChangedFiles(filesChanged) !== 'file_deliverable') return [];
  return filesChanged.filter(file => !isEngineeringDeliverablePath(file));
}

/** @deprecated 使用 {@link fileDeliverablePaths} */
export function documentDeliverablePaths(filesChanged: readonly string[]): string[] {
  return fileDeliverablePaths(filesChanged);
}

/** @deprecated 仅用于旧测试；未知扩展名现属 file_deliverable 而非 document 子集 */
export function isDocumentDeliverablePath(path: string): boolean {
  const ext = fileExtension(path);
  if (!ext) return false;
  const docLike = new Set([
    'md', 'markdown', 'txt', 'doc', 'docx', 'pdf', 'html', 'htm', 'mdx', 'log',
  ]);
  return docLike.has(ext);
}

export function pathsReferToSameFile(a: string, b: string): boolean {
  return normalizeDeliverablePath(a) === normalizeDeliverablePath(b);
}

export function isFileDeliverableConfirmationTool(toolName: string): boolean {
  return FILE_DELIVERABLE_CONFIRM_TOOLS.has(toolName);
}

/** @deprecated 使用 {@link isFileDeliverableConfirmationTool} */
export function isDocumentConfirmationTool(toolName: string): boolean {
  return isFileDeliverableConfirmationTool(toolName);
}

export function canVerifyDeliverableKind(
  kind: DeliverableKind,
  toolNames: readonly string[],
): boolean {
  if (kind === 'none') return false;
  if (kind === 'file_deliverable') {
    return toolNames.some(name => FILE_DELIVERABLE_CONFIRM_TOOLS.has(name));
  }
  return toolNames.some(name => name === 'run_command');
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

  const g = goal.toLowerCase();
  return /readme|文档|markdown|\.md\b|docx|\.pdf\b|报告|report|pptx|xlsx|整理.*md|写成.*文档|生成.*文档|清理|cleanup/i.test(g)
    || /write.*readme|documentation|markdown file/i.test(g);
}

/** @deprecated 使用 {@link isFileDeliverableOrientedTask} */
export function isDocumentOrientedTask(
  goal: string,
  filesChanged: readonly string[],
): boolean {
  return isFileDeliverableOrientedTask(goal, filesChanged);
}
