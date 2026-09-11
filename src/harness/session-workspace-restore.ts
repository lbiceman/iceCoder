/**
 * Session 级工作区回滚 — 从 Intent Checkpoint + 会话 tool trace 还原文件内容（类似 Cursor Restore）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { IntentCheckpointArchive, UiChatMessage } from '../types/intent-checkpoint.js';
import { readUiSessionMessages } from './intent-checkpoint-capture.js';
import { loadCheckpointIndex, loadIntentCheckpoint } from './intent-checkpoint-store.js';
import { extractUnifiedDiffFromText } from '../web/tool-display-extract.js';
import { readToolTraceDiffIndex } from '../web/session-tool-trace-diffs.js';
import { remapPathToWorkspace, remapSnapshotToWorkspace } from './workspace-snapshot.js';

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'batch_edit_file',
  'patch_file',
]);

const PATH_WRITE_TOOLS = new Set([
  ...WRITE_TOOLS,
  'fs_operation',
]);

function isFailedToolTrace(status: string | undefined): boolean {
  return status === 'failed'
    || status === 'error'
    || status === 'warn'
    || status === 'pending'
    || status === 'background';
}

/**
 * write_file 在目标不存在时用空字符串当旧内容，diff 是 `--- 1.txt` 加一行空 `-`，
 * 而不是 git 的 `--- /dev/null`。这两种都表示检查点之后新建的文件。
 */
export function isNewFileUnifiedDiff(diffText: string): boolean {
  const diff = extractUnifiedDiffFromText(diffText) ?? diffText;
  if (!diff.trim()) return false;
  if (/^---\s+\/dev\/null/m.test(diff)) return true;
  const hunks = parseUnifiedDiff(diff);
  if (hunks.length === 0) return false;
  const oldLines = hunks.flatMap((h) =>
    h.lines.filter((l) => l.type === 'context' || l.type === 'delete').map((l) => l.content),
  );
  return oldLines.length === 0 || oldLines.every((line) => line === '');
}

type HunkLine = { type: 'context' | 'delete' | 'insert'; content: string };

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

function parseUnifiedDiff(patch: string): Hunk[] {
  const lines = patch.split('\n');
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of lines) {
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      if (current) hunks.push(current);
      current = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] !== undefined ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('-')) {
      current.lines.push({ type: 'delete', content: line.slice(1) });
    } else if (line.startsWith('+')) {
      current.lines.push({ type: 'insert', content: line.slice(1) });
    } else if (line.startsWith(' ') || line === '') {
      current.lines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function invertHunks(hunks: Hunk[]): Hunk[] {
  return hunks.map((h) => ({
    oldStart: h.newStart,
    oldCount: h.newCount,
    newStart: h.oldStart,
    newCount: h.oldCount,
    lines: h.lines.map((l) => ({
      type: l.type === 'delete' ? 'insert' as const : l.type === 'insert' ? 'delete' as const : 'context' as const,
      content: l.content,
    })),
  }));
}

function findMatch(fileLines: string[], searchLines: string[], startPos: number): number {
  if (startPos < 0 || startPos + searchLines.length > fileLines.length) return -1;
  for (let i = 0; i < searchLines.length; i++) {
    if (fileLines[startPos + i] !== searchLines[i]) return -1;
  }
  return startPos;
}

function applyHunks(originalLines: string[], hunks: Hunk[]): string[] | null {
  let result = [...originalLines];
  let offset = 0;

  for (const hunk of hunks) {
    const targetLine = hunk.oldStart - 1 + offset;
    const oldLines = hunk.lines
      .filter((l) => l.type === 'context' || l.type === 'delete')
      .map((l) => l.content);

    let matchPos = findMatch(result, oldLines, targetLine);
    if (matchPos === -1) {
      for (let delta = 1; delta <= 50; delta++) {
        matchPos = findMatch(result, oldLines, targetLine - delta);
        if (matchPos !== -1) break;
        matchPos = findMatch(result, oldLines, targetLine + delta);
        if (matchPos !== -1) break;
      }
    }
    if (matchPos === -1) return null;

    const newLines = hunk.lines
      .filter((l) => l.type === 'context' || l.type === 'insert')
      .map((l) => l.content);
    result.splice(matchPos, oldLines.length, ...newLines);
    offset += newLines.length - oldLines.length;
  }
  return result;
}

/** 从 unified diff 直接提取变更前全文（工具 diff 为 old→new）。 */
function extractPreImageFromUnifiedDiff(diffText: string): string | null {
  const diff = extractUnifiedDiffFromText(diffText);
  if (!diff) return null;
  if (/^---\s+\/dev\/null/m.test(diff)) return '';
  const hunks = parseUnifiedDiff(diff);
  if (hunks.length === 0) return null;
  const lines: string[] = [];
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      if (l.type === 'context' || l.type === 'delete') lines.push(l.content);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** 用 unified diff 把当前内容还原为变更前（diff 为 old→new）。 */
export function revertContentUsingUnifiedDiff(
  currentContent: string,
  diffText: string,
): string | null {
  if (isNewFileUnifiedDiff(diffText)) {
    const fromDiff = extractPreImageFromUnifiedDiff(diffText);
    return fromDiff ?? '';
  }

  const diff = extractUnifiedDiffFromText(diffText);
  if (!diff) return null;
  const hunks = parseUnifiedDiff(diff);
  if (hunks.length === 0) return extractPreImageFromUnifiedDiff(diffText);

  // 局部 hunk 不能拼成全文：对当前文件反应用 hunk，避免大文件被截成几行。
  const reverted = applyHunks(currentContent.split('\n'), invertHunks(hunks));
  if (reverted) return reverted.join('\n');
  return extractPreImageFromUnifiedDiff(diffText);
}

function resolveUserMessageIndex(
  uiMessages: UiChatMessage[],
  targetMessageId: string,
  archive?: IntentCheckpointArchive,
): number {
  const exact = uiMessages.findIndex((m) => m.id === targetMessageId);
  if (exact >= 0) return exact;
  const archived = archive?.uiMessages.find((m) => m.id === targetMessageId && m.role === 'user');
  const text = typeof archived?.content === 'string' ? archived.content.trim() : '';
  if (!text) return -1;
  return uiMessages.findIndex((m) => m.role === 'user' && String(m.content || '').trim() === text);
}

function normalizeRelPath(workspaceRoot: string, raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  return remapPathToWorkspace(workspaceRoot, raw.trim());
}

async function readWorkspaceFileText(
  workspaceRoot: string,
  relPath: string,
): Promise<string | null> {
  const abs = path.resolve(path.resolve(workspaceRoot), remapPathToWorkspace(workspaceRoot, relPath) ?? relPath);
  try {
    return await fs.readFile(abs, 'utf-8');
  } catch {
    return null;
  }
}

interface WriteTraceEntry {
  relPath: string;
  diff: string;
}

function collectWriteTracesAfterMessage(
  uiMessages: UiChatMessage[],
  targetMessageId: string,
  diffIndex: Record<string, string>,
  workspaceRoot: string,
  archive?: IntentCheckpointArchive,
): WriteTraceEntry[] {
  const targetIdx = resolveUserMessageIndex(uiMessages, targetMessageId, archive);
  if (targetIdx < 0) return [];

  const entries: WriteTraceEntry[] = [];
  for (let i = targetIdx + 1; i < uiMessages.length; i++) {
    const m = uiMessages[i];
    if (m.role !== 'tool_trace' || !m.toolName || !WRITE_TOOLS.has(m.toolName)) continue;
    if (isFailedToolTrace(m.status)) continue;
    const relPath = normalizeRelPath(workspaceRoot, m.detail);
    if (!relPath) continue;
    const diff = (typeof m.diffSource === 'string' && m.diffSource)
      || (m.toolCallId ? diffIndex[m.toolCallId] : undefined);
    if (!diff) continue;
    entries.push({ relPath, diff });
  }
  return entries;
}

function collectWrittenRelPathsInMessageRange(
  uiMessages: UiChatMessage[],
  startExclusive: number,
  endExclusive: number,
  workspaceRoot: string,
): string[] {
  const paths = new Set<string>();
  const from = Math.max(0, startExclusive + 1);
  const to = Math.min(uiMessages.length, endExclusive);
  for (let i = from; i < to; i++) {
    const m = uiMessages[i];
    if (m.role !== 'tool_trace' || !m.toolName || !PATH_WRITE_TOOLS.has(m.toolName)) continue;
    if (isFailedToolTrace(m.status)) continue;
    const relPath = normalizeRelPath(workspaceRoot, m.detail);
    if (!relPath || relPath === '.' || relPath === '..' || relPath.endsWith('/')) continue;
    paths.add(relPath);
  }
  return [...paths];
}

/** 目标消息之后所有写入类工具涉及的相对路径（含无 diff 的 write_file / fs_operation）。 */
export function collectWrittenRelPathsAfterMessage(
  uiMessages: UiChatMessage[],
  targetMessageId: string,
  workspaceRoot: string,
  archive?: IntentCheckpointArchive,
): string[] {
  const targetIdx = resolveUserMessageIndex(uiMessages, targetMessageId, archive);
  if (targetIdx < 0) return [];
  return collectWrittenRelPathsInMessageRange(uiMessages, targetIdx, uiMessages.length, workspaceRoot);
}

/** 目标检查点发出之前已经写入过的路径（更早一步已经存在的文件）。 */
export function collectWrittenRelPathsBeforeMessage(
  uiMessages: UiChatMessage[],
  targetMessageId: string,
  workspaceRoot: string,
  archive?: IntentCheckpointArchive,
): string[] {
  const targetIdx = resolveUserMessageIndex(uiMessages, targetMessageId, archive);
  if (targetIdx < 0) return [];
  return collectWrittenRelPathsInMessageRange(uiMessages, -1, targetIdx, workspaceRoot);
}

export async function collectExistedRelPathsAtCheckpoint(opts: {
  archive: IntentCheckpointArchive;
  sessionDir: string;
  sessionId: string;
  workspaceRoot: string;
  snapshot: Record<string, string | null>;
  uiMessages: UiChatMessage[];
}): Promise<Set<string>> {
  const { archive, sessionDir, sessionId, workspaceRoot, snapshot, uiMessages } = opts;
  const existed = new Set(
    Object.entries(snapshot)
      .filter(([, content]) => content !== null)
      .map(([rel]) => rel),
  );
  for (const relPath of collectWrittenRelPathsBeforeMessage(
    uiMessages,
    archive.messageId,
    workspaceRoot,
    archive,
  )) {
    existed.add(relPath);
  }
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  const targetIdx = index.entries.findIndex((e) => e.messageId === archive.messageId);
  for (let i = 0; i < targetIdx; i++) {
    const earlier = await loadIntentCheckpoint(sessionDir, sessionId, index.entries[i].messageId);
    if (!earlier) continue;
    const remapped = remapSnapshotToWorkspace(workspaceRoot, earlier.workspaceFiles);
    for (const [rel, content] of Object.entries(remapped)) {
      if (content !== null) existed.add(rel);
    }
  }
  return existed;
}

function reconstructedPreImageIsMissingFile(
  content: string,
  pathWrites: WriteTraceEntry[],
): boolean {
  if (content.trim() === '') return true;
  // 只看该路径在检查点之后的第一次写入：先新建再改内容，仍应删除。
  return pathWrites.length > 0 && isNewFileUnifiedDiff(pathWrites[0].diff);
}

/** 合并 checkpoint 快照 + 会话 tool trace 逆向 diff，供 Restore 写回磁盘。 */
export async function buildSessionWorkspaceRestoreSnapshot(opts: {
  archive: IntentCheckpointArchive;
  sessionDir: string;
  sessionId: string;
  workspaceRoot: string;
  currentUiMessages?: UiChatMessage[];
}): Promise<Record<string, string | null>> {
  const { sessionDir, sessionId, workspaceRoot, archive } = opts;
  const snapshot: Record<string, string | null> = remapSnapshotToWorkspace(
    workspaceRoot,
    archive.workspaceFiles,
  );

  const fresh = await loadIntentCheckpoint(sessionDir, sessionId, archive.messageId);
  if (fresh) {
    const remappedFresh = remapSnapshotToWorkspace(workspaceRoot, fresh.workspaceFiles);
    for (const [rel, content] of Object.entries(remappedFresh)) {
      if (!(rel in snapshot) || content === null) snapshot[rel] = content;
    }
  }

  const uiMessages = opts.currentUiMessages
    ?? await readUiSessionMessages(sessionDir, sessionId);
  const diffIndex = await readToolTraceDiffIndex(sessionDir, sessionId);
  const writes = collectWriteTracesAfterMessage(
    uiMessages,
    archive.messageId,
    diffIndex,
    workspaceRoot,
    archive,
  );

  const byPath = new Map<string, WriteTraceEntry[]>();
  for (const w of writes) {
    const list = byPath.get(w.relPath) ?? [];
    list.push(w);
    byPath.set(w.relPath, list);
  }

  const existedAtCheckpoint = await collectExistedRelPathsAtCheckpoint({
    archive,
    sessionDir,
    sessionId,
    workspaceRoot,
    snapshot,
    uiMessages,
  });

  for (const [relPath, pathWrites] of byPath) {
    if (relPath in snapshot) continue;
    let content = await readWorkspaceFileText(workspaceRoot, relPath);
    if (content === null) content = '';
    for (let i = pathWrites.length - 1; i >= 0; i--) {
      const reverted = revertContentUsingUnifiedDiff(content, pathWrites[i].diff);
      if (reverted === null) {
        content = null;
        break;
      }
      content = reverted;
    }
    if (content !== null) {
      const missing = reconstructedPreImageIsMissingFile(content, pathWrites);
      snapshot[relPath] = missing && !existedAtCheckpoint.has(relPath)
        ? null
        : content;
    }
  }

  for (const relPath of collectWrittenRelPathsAfterMessage(
    uiMessages,
    archive.messageId,
    workspaceRoot,
    archive,
  )) {
    if (existedAtCheckpoint.has(relPath)) continue;
    const reconstructed = snapshot[relPath];
    if (typeof reconstructed === 'string' && reconstructed.trim() !== '') continue;
    snapshot[relPath] = null;
  }

  const recovered = await recoverMissingExistedContent({
    sessionDir,
    sessionId,
    workspaceRoot,
    archiveMessageId: archive.messageId,
    snapshot,
    existedAtCheckpoint,
  });
  for (const [rel, content] of Object.entries(recovered)) {
    if (!(rel in snapshot)) snapshot[rel] = content;
  }

  return snapshot;
}

async function recoverMissingExistedContent(opts: {
  sessionDir: string;
  sessionId: string;
  workspaceRoot: string;
  archiveMessageId: string;
  snapshot: Record<string, string | null>;
  existedAtCheckpoint: Set<string>;
}): Promise<Record<string, string>> {
  const missing = [...opts.existedAtCheckpoint].filter((rel) => !(rel in opts.snapshot));
  if (missing.length === 0) return {};

  const index = await loadCheckpointIndex(opts.sessionDir, opts.sessionId);
  const targetIdx = index.entries.findIndex((e) => e.messageId === opts.archiveMessageId);
  const found: Record<string, string> = {};
  const still = new Set(missing);

  for (let i = targetIdx - 1; i >= 0 && still.size; i--) {
    const earlier = await loadIntentCheckpoint(
      opts.sessionDir,
      opts.sessionId,
      index.entries[i].messageId,
    );
    if (!earlier) continue;
    const remapped = remapSnapshotToWorkspace(opts.workspaceRoot, earlier.workspaceFiles);
    for (const rel of still) {
      const content = remapped[rel];
      if (typeof content === 'string') {
        found[rel] = content;
        still.delete(rel);
      }
    }
  }

  for (let i = targetIdx + 1; i < index.entries.length && still.size; i++) {
    const later = await loadIntentCheckpoint(
      opts.sessionDir,
      opts.sessionId,
      index.entries[i].messageId,
    );
    if (!later) continue;
    const remapped = remapSnapshotToWorkspace(opts.workspaceRoot, later.workspaceFiles);
    for (const rel of still) {
      const content = remapped[rel];
      if (typeof content === 'string') {
        found[rel] = content;
        still.delete(rel);
      }
    }
  }

  return found;
}
