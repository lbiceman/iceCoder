/**
 * 章节现场：读的时候用相邻检查点的文件内容哈希做对比。
 * 不写新字段。文件正文只在展开 diff 时才读取。
 *
 * 浏览器编年史 etl-chronicle.ts 里的测试命令判断要和 isTestCommand 保持一致。
 */

import type { IntentFileRef } from './intent-checkpoint-blobs.js';
import type { UiChatMessage } from '../types/intent-checkpoint.js';

export type ChapterTestVerdict = 'passed' | 'failed' | 'running' | 'none';
export type ChapterSceneOp = 'added' | 'modified' | 'deleted' | 'command';

export interface ChapterSceneFile {
  path: string;
  op: ChapterSceneOp;
  toolCallId: string;
}

export interface ChapterSceneSummary {
  messageId: string;
  sealed: boolean;
  fileCount: number;
  test: ChapterTestVerdict;
}

export interface ChapterSceneDetail extends ChapterSceneSummary {
  files: ChapterSceneFile[];
}

export interface ChapterSceneDiff {
  path: string;
  op: ChapterSceneOp;
  binary: boolean;
  truncated: boolean;
  pending: boolean;
  additions: number;
  deletions: number;
  diff: string;
}

export interface SceneTrace {
  toolName: string;
  detail: string;
  status: string;
  toolCallId: string;
  diffSource: string;
}

const WRITE_TOOLS: Record<string, true> = {
  write_file: true,
  append_file: true,
  edit_file: true,
  patch_file: true,
  batch_edit_file: true,
  fs_operation: true,
  apply_patch: true,
  undo_edit: true,
  create_file: true,
  multi_edit: true,
};

const READ_TOOLS: Record<string, true> = {
  read_file: true,
  file_info: true,
  notebook_read: true,
  open_file: true,
};

/** 与 etl-chronicle.ts 的 TEST_COMMAND_RE 同步。 */
const TEST_COMMAND_RE = /(?:^|[^\w.-])(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test\b|\b(?:vitest|jest|pytest|phpunit|rspec)\b|\bgo\s+test\b|\bcargo\s+test\b|\bmvn\s+(?:test|verify)\b|\bgradle(?:w)?\s+test\b|\bdotnet\s+test\b|\bctest\b/i;

const DIFF_LCS_MAX = 350;
const DIFF_OUTPUT_MAX = 200;
const DIFF_COARSE_MAX = 80;

export function normalizeScenePath(value: string): string {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function scenePathKey(value: string): string {
  return normalizeScenePath(value).toLowerCase();
}

export function isScenePath(value: string): boolean {
  const path = normalizeScenePath(value);
  if (!path || path === '.' || path === '..' || path.length > 400) return false;
  if (path.startsWith('{') || path.startsWith('[')) return false;
  if (path.split('/').some((part) => part === '..')) return false;
  return true;
}

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND_RE.test(String(command || '').trim());
}

export function refIdentity(ref: IntentFileRef | null | undefined): string | null {
  if (ref == null) return null;
  if ('hash' in ref) return ref.hash;
  return `inline:${ref.inline}`;
}

export interface RefChange {
  path: string;
  op: 'added' | 'modified' | 'deleted';
}

/**
 * 比较两份「路径 → 内容引用」。引用相同的路径跳过，不读正文。
 * 后一份里消失的路径不当成删除：跟踪名单变了，不代表文件被删。
 * 内容变成 null 才是删除。
 */
export function diffFileRefs(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
): RefChange[] {
  const beforeByKey = new Map<string, { path: string; ref: string | null }>();
  const afterByKey = new Map<string, { path: string; ref: string | null }>();
  for (const [raw, ref] of Object.entries(before)) {
    const path = normalizeScenePath(raw);
    if (!isScenePath(path)) continue;
    beforeByKey.set(scenePathKey(path), { path, ref });
  }
  for (const [raw, ref] of Object.entries(after)) {
    const path = normalizeScenePath(raw);
    if (!isScenePath(path)) continue;
    afterByKey.set(scenePathKey(path), { path, ref });
  }

  const changes: RefChange[] = [];
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  for (const key of keys) {
    const left = beforeByKey.get(key);
    const right = afterByKey.get(key);
    const beforeRef = left ? left.ref : null;
    const afterRef = right ? right.ref : null;
    if (beforeRef === afterRef) continue;
    if (beforeRef == null && afterRef == null) continue;
    if (beforeRef == null && afterRef != null && right) {
      changes.push({ path: right.path, op: 'added' });
      continue;
    }
    if (beforeRef != null && right && afterRef == null) {
      changes.push({ path: left!.path, op: 'deleted' });
      continue;
    }
    if (left && right && beforeRef != null && afterRef != null) {
      changes.push({ path: right.path, op: 'modified' });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

function traceStatus(status: string): 'failed' | 'running' | 'done' {
  if (status === 'failed' || status === 'error' || status === 'warn') return 'failed';
  if (status === 'running' || status === 'pending') return 'running';
  return 'done';
}

function isRealUserBoundary(msg: UiChatMessage): boolean {
  if (!msg || msg.role !== 'user' || msg.alsoNote) return false;
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  return text.length > 0;
}

/** 这一章的工具记录：从这句用户消息到下一句用户消息之前。 */
export function tracesForChapter(
  messages: readonly UiChatMessage[],
  messageId: string,
  nextMessageId: string | null,
): SceneTrace[] {
  const out: SceneTrace[] = [];
  let started = false;
  for (const msg of messages) {
    if (!started) {
      if (msg && msg.role === 'user' && msg.id === messageId) started = true;
      continue;
    }
    if (isRealUserBoundary(msg)) {
      if (!nextMessageId || msg.id === nextMessageId || msg.id !== messageId) break;
    }
    if (!msg || msg.role !== 'tool_trace' || !msg.toolName) continue;
    out.push({
      toolName: msg.toolName,
      detail: typeof msg.detail === 'string' ? msg.detail : '',
      status: typeof msg.status === 'string' ? msg.status : '',
      toolCallId: typeof msg.toolCallId === 'string' ? msg.toolCallId : '',
      diffSource: typeof msg.diffSource === 'string' ? msg.diffSource : '',
    });
  }
  return out;
}

export function pickTestVerdict(traces: readonly SceneTrace[]): ChapterTestVerdict {
  let verdict: ChapterTestVerdict = 'none';
  for (const trace of traces) {
    if (trace.toolName !== 'run_command') continue;
    if (!isTestCommand(trace.detail)) continue;
    const status = traceStatus(trace.status);
    if (status === 'failed') verdict = 'failed';
    else if (status === 'running') verdict = 'running';
    else verdict = 'passed';
  }
  return verdict;
}

function writeOp(toolName: string): ChapterSceneOp {
  if (toolName === 'write_file' || toolName === 'create_file') return 'added';
  if (toolName === 'undo_edit') return 'deleted';
  return 'modified';
}

/**
 * 树上哈希变了的路径都留下。
 * 只在后一章才出现的路径：写工具点了名就留下；否则仅当这一章跑过命令、且不是只读路径时标成命令改动。
 * 这样新读进跟踪名单的旧文件不会被看成这一章新建的。
 */
export function composeChapterFiles(
  treeChanges: readonly RefChange[],
  traces: readonly SceneTrace[],
): ChapterSceneFile[] {
  const writes = new Map<string, SceneTrace>();
  const reads = new Set<string>();
  let hasCommand = false;
  for (const trace of traces) {
    if (trace.toolName === 'run_command') hasCommand = true;
    const path = normalizeScenePath(trace.detail);
    if (!isScenePath(path)) continue;
    const key = scenePathKey(path);
    if (traceStatus(trace.status) === 'failed') continue;
    if (WRITE_TOOLS[trace.toolName]) writes.set(key, trace);
    else if (READ_TOOLS[trace.toolName]) reads.add(key);
  }

  const files: ChapterSceneFile[] = [];
  const seen = new Set<string>();
  for (const change of treeChanges) {
    const key = scenePathKey(change.path);
    const write = writes.get(key);
    if (change.op === 'added' && !write) {
      if (!(hasCommand && !reads.has(key))) continue;
      files.push({ path: change.path, op: 'command', toolCallId: '' });
      seen.add(key);
      continue;
    }
    files.push({
      path: change.path,
      op: change.op,
      toolCallId: write?.toolCallId || '',
    });
    seen.add(key);
  }

  for (const [key, write] of writes) {
    if (seen.has(key)) continue;
    const path = normalizeScenePath(write.detail);
    if (!isScenePath(path)) continue;
    files.push({ path, op: writeOp(write.toolName), toolCallId: write.toolCallId });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export function summarizeScene(
  messageId: string,
  sealed: boolean,
  files: readonly ChapterSceneFile[],
  test: ChapterTestVerdict,
): ChapterSceneSummary {
  return { messageId, sealed, fileCount: files.length, test };
}

interface DiffRow {
  op: ' ' | '+' | '-' | '@';
  line: string;
}

function splitLines(text: string | null): string[] {
  if (text == null || text === '') return [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function isBinaryText(text: string | null): boolean {
  if (!text) return false;
  return text.slice(0, 8000).includes('\0');
}

function lcsRows(a: string[], b: string[]): DiffRow[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: '-', line: a[i]! });
      i++;
    } else {
      out.push({ op: '+', line: b[j]! });
      j++;
    }
  }
  while (i < n) out.push({ op: '-', line: a[i++]! });
  while (j < m) out.push({ op: '+', line: b[j++]! });
  return out;
}

function coarseRows(a: string[], b: string[]): { rows: DiffRow[]; truncated: boolean } {
  const rows: DiffRow[] = [];
  let truncated = false;
  const del = a.slice(0, DIFF_COARSE_MAX);
  const add = b.slice(0, DIFF_COARSE_MAX);
  if (a.length > DIFF_COARSE_MAX || b.length > DIFF_COARSE_MAX) truncated = true;
  for (const line of del) rows.push({ op: '-', line });
  for (const line of add) rows.push({ op: '+', line });
  return { rows, truncated };
}

function rowsForChange(before: string | null, after: string | null): { rows: DiffRow[]; truncated: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix
    && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  const context = 1;
  const preStart = Math.max(0, prefix - context);
  const rows: DiffRow[] = [];
  for (const line of a.slice(preStart, prefix)) rows.push({ op: ' ', line });
  if (aMid.length <= DIFF_LCS_MAX && bMid.length <= DIFF_LCS_MAX) {
    for (const row of lcsRows(aMid, bMid)) {
      if (row.op !== ' ') rows.push(row);
    }
  } else {
    const coarse = coarseRows(aMid, bMid);
    rows.push(...coarse.rows);
    if (coarse.truncated) return { rows, truncated: true };
  }
  const postEnd = Math.min(a.length, a.length - suffix + context);
  for (const line of a.slice(a.length - suffix, postEnd)) rows.push({ op: ' ', line });
  return { rows, truncated: false };
}

function formatDiff(rows: DiffRow[], alreadyTruncated: boolean): { diff: string; additions: number; deletions: number; truncated: boolean } {
  let additions = 0;
  let deletions = 0;
  const lines: string[] = [];
  for (const row of rows) {
    if (row.op === '+') additions++;
    else if (row.op === '-') deletions++;
    if (lines.length < DIFF_OUTPUT_MAX) lines.push(`${row.op === ' ' ? ' ' : row.op}${row.line}`);
  }
  const truncated = alreadyTruncated || rows.length > DIFF_OUTPUT_MAX;
  return { diff: lines.join('\n'), additions, deletions, truncated };
}

export function buildSceneDiff(
  before: string | null,
  after: string | null,
  path: string,
  op: ChapterSceneOp,
): ChapterSceneDiff {
  if (isBinaryText(before) || isBinaryText(after)) {
    return {
      path, op, binary: true, truncated: false, pending: false, additions: 0, deletions: 0, diff: '',
    };
  }
  const built = rowsForChange(before, after);
  const formatted = formatDiff(built.rows, built.truncated);
  return {
    path,
    op,
    binary: false,
    truncated: formatted.truncated,
    pending: false,
    additions: formatted.additions,
    deletions: formatted.deletions,
    diff: formatted.diff,
  };
}

export function diffFromStoredSource(
  source: string,
  path: string,
  op: ChapterSceneOp,
): ChapterSceneDiff {
  const text = String(source || '');
  if (!text.trim()) {
    return {
      path, op, binary: false, truncated: false, pending: true, additions: 0, deletions: 0, diff: '',
    };
  }
  const lines = text.split('\n');
  let additions = 0;
  let deletions = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  const truncated = lines.length > DIFF_OUTPUT_MAX;
  return {
    path,
    op,
    binary: false,
    truncated,
    pending: false,
    additions,
    deletions,
    diff: truncated ? lines.slice(0, DIFF_OUTPUT_MAX).join('\n') : text,
  };
}
