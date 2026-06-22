/**
 * Session 级工作区回滚 — 从 Intent Checkpoint + 会话 tool trace 还原文件内容（类似 Cursor Restore）。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { IntentCheckpointArchive, UiChatMessage } from '../types/intent-checkpoint.js';
import { readUiSessionMessages } from './intent-checkpoint-capture.js';
import { loadIntentCheckpoint } from './intent-checkpoint-store.js';
import { extractUnifiedDiffFromText } from '../web/tool-display-extract.js';
import { readToolTraceDiffIndex } from '../web/session-tool-trace-diffs.js';
import { toPosixRel } from './workspace-snapshot.js';

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'batch_edit_file',
  'patch_file',
]);

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
  const fromDiff = extractPreImageFromUnifiedDiff(diffText);
  if (fromDiff !== null) return fromDiff;

  const diff = extractUnifiedDiffFromText(diffText);
  if (!diff) return null;
  const hunks = parseUnifiedDiff(diff);
  if (hunks.length === 0) return null;
  const lines = currentContent.split('\n');
  const reverted = applyHunks(lines, invertHunks(hunks));
  return reverted && reverted.length > 0 ? reverted.join('\n') : null;
}

function normalizeRelPath(workspaceRoot: string, raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (trimmed.includes('/')) return trimmed.replace(/^\/+/, '');
  const abs = path.resolve(workspaceRoot, trimmed);
  return toPosixRel(workspaceRoot, abs);
}

async function readWorkspaceFileText(
  workspaceRoot: string,
  relPath: string,
): Promise<string | null> {
  const abs = path.join(path.resolve(workspaceRoot), ...relPath.split('/'));
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
): WriteTraceEntry[] {
  const targetIdx = uiMessages.findIndex((m) => m.id === targetMessageId);
  if (targetIdx < 0) return [];

  const entries: WriteTraceEntry[] = [];
  for (let i = targetIdx + 1; i < uiMessages.length; i++) {
    const m = uiMessages[i];
    if (m.role !== 'tool_trace' || !m.toolName || !WRITE_TOOLS.has(m.toolName)) continue;
    const relPath = normalizeRelPath(workspaceRoot, m.detail);
    if (!relPath) continue;
    const diff = (typeof m.diffSource === 'string' && m.diffSource)
      || (m.toolCallId ? diffIndex[m.toolCallId] : undefined);
    if (!diff) continue;
    entries.push({ relPath, diff });
  }
  return entries;
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
  const snapshot: Record<string, string | null> = { ...archive.workspaceFiles };

  const fresh = await loadIntentCheckpoint(sessionDir, sessionId, archive.messageId);
  if (fresh) {
    for (const [rel, content] of Object.entries(fresh.workspaceFiles)) {
      snapshot[rel.replace(/\\/g, '/')] = content;
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
  );

  const byPath = new Map<string, WriteTraceEntry[]>();
  for (const w of writes) {
    const list = byPath.get(w.relPath) ?? [];
    list.push(w);
    byPath.set(w.relPath, list);
  }

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
      snapshot[relPath] = content === '' && pathWrites.some((w) => w.diff.includes('/dev/null'))
        ? null
        : content;
    }
  }

  return snapshot;
}
