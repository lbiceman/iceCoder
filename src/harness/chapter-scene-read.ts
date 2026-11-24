/**
 * 把检查点哈希和已有工具记录装成章节现场。只读，不写会话文件。
 */

import { IntentCheckpointCorruptError, type IntentFileRef } from './intent-checkpoint-blobs.js';
import { readUiSessionMessages } from './intent-checkpoint-capture.js';
import {
  loadCheckpointIndex,
  loadIntentCheckpointHead,
  readIntentCheckpointFile,
} from './intent-checkpoint-store.js';
import { IntentBlobStore } from './intent-checkpoint-blob-io.js';
import type { CheckpointIndexEntry } from '../types/intent-checkpoint.js';
import type { UiChatMessage } from '../types/intent-checkpoint.js';
import {
  buildSceneDiff,
  composeChapterFiles,
  diffFileRefs,
  diffFromStoredSource,
  isScenePath,
  normalizeScenePath,
  pickTestVerdict,
  refIdentity,
  summarizeScene,
  tracesForChapter,
  type ChapterSceneDetail,
  type ChapterSceneDiff,
  type ChapterSceneFile,
  type ChapterSceneOp,
  type ChapterSceneSummary,
  type SceneTrace,
} from './chapter-scene.js';

interface LoadedHead {
  files: Record<string, IntentFileRef | null>;
}

function sortEntries(entries: CheckpointIndexEntry[]): CheckpointIndexEntry[] {
  return entries.slice().sort((a, b) => {
    const ta = a.userMessageTime ?? (Date.parse(a.createdAt) || 0);
    const tb = b.userMessageTime ?? (Date.parse(b.createdAt) || 0);
    if (ta !== tb) return ta - tb;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function refMap(head: LoadedHead | null): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!head) return out;
  for (const [path, ref] of Object.entries(head.files)) {
    out[path] = refIdentity(ref);
  }
  return out;
}

async function loadHeads(
  sessionDir: string,
  sessionId: string,
  entries: CheckpointIndexEntry[],
): Promise<Map<string, LoadedHead | null>> {
  const store = new IntentBlobStore(sessionDir, sessionId);
  const heads = new Map<string, LoadedHead | null>();
  for (const entry of entries) {
    try {
      const head = await loadIntentCheckpointHead(sessionDir, sessionId, entry.messageId, store);
      heads.set(entry.messageId, head ? { files: head.files } : null);
    } catch (err) {
      if (err instanceof IntentCheckpointCorruptError) {
        heads.set(entry.messageId, null);
        continue;
      }
      throw err;
    }
  }
  return heads;
}

function sceneForEntry(
  entry: CheckpointIndexEntry,
  next: CheckpointIndexEntry | undefined,
  heads: Map<string, LoadedHead | null>,
  messages: readonly UiChatMessage[],
): ChapterSceneDetail {
  const traces = tracesForChapter(messages, entry.messageId, next?.messageId ?? null);
  const before = heads.get(entry.messageId) ?? null;
  const after = next ? heads.get(next.messageId) ?? null : null;
  const sealed = !!(next && before && after);
  const treeChanges = sealed ? diffFileRefs(refMap(before), refMap(after)) : [];
  const files = composeChapterFiles(treeChanges, traces);
  const test = pickTestVerdict(traces);
  return {
    ...summarizeScene(entry.messageId, sealed, files, test),
    files,
  };
}

export async function readChapterScenes(
  sessionDir: string,
  sessionId: string,
): Promise<ChapterSceneSummary[]> {
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  const entries = sortEntries(index.entries);
  if (!entries.length) return [];
  const [heads, messages] = await Promise.all([
    loadHeads(sessionDir, sessionId, entries),
    readUiSessionMessages(sessionDir, sessionId),
  ]);
  return entries.map((entry, i) => {
    const detail = sceneForEntry(entry, entries[i + 1], heads, messages);
    return summarizeScene(detail.messageId, detail.sealed, detail.files, detail.test);
  });
}

export async function readChapterScene(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<ChapterSceneDetail | null> {
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  const entries = sortEntries(index.entries);
  const at = entries.findIndex((entry) => entry.messageId === messageId);
  if (at < 0) return null;
  const slice = [entries[at]!, entries[at + 1]].filter((entry): entry is CheckpointIndexEntry => !!entry);
  const [heads, messages] = await Promise.all([
    loadHeads(sessionDir, sessionId, slice),
    readUiSessionMessages(sessionDir, sessionId),
  ]);
  return sceneForEntry(entries[at]!, entries[at + 1], heads, messages);
}

function findFile(files: readonly ChapterSceneFile[], relPath: string): ChapterSceneFile | null {
  const key = normalizeScenePath(relPath).toLowerCase();
  return files.find((file) => file.path.toLowerCase() === key) ?? null;
}

function lookupRef(
  head: LoadedHead | null,
  relPath: string,
): IntentFileRef | null | undefined {
  if (!head) return undefined;
  const key = normalizeScenePath(relPath).toLowerCase();
  for (const [path, ref] of Object.entries(head.files)) {
    if (normalizeScenePath(path).toLowerCase() === key) return ref;
  }
  return undefined;
}

function storedDiffForPath(traces: readonly SceneTrace[], relPath: string): string {
  const key = normalizeScenePath(relPath).toLowerCase();
  for (let i = traces.length - 1; i >= 0; i--) {
    const trace = traces[i]!;
    if (normalizeScenePath(trace.detail).toLowerCase() !== key) continue;
    if (trace.diffSource) return trace.diffSource;
  }
  return '';
}

export async function readChapterSceneDiff(
  sessionDir: string,
  sessionId: string,
  messageId: string,
  relPath: string,
): Promise<ChapterSceneDiff | null> {
  if (!isScenePath(relPath)) return null;
  const scene = await readChapterScene(sessionDir, sessionId, messageId);
  if (!scene) return null;
  const file = findFile(scene.files, relPath);
  if (!file) return null;

  const index = await loadCheckpointIndex(sessionDir, sessionId);
  const entries = sortEntries(index.entries);
  const at = entries.findIndex((entry) => entry.messageId === messageId);
  const next = at >= 0 ? entries[at + 1] : undefined;
  const messages = await readUiSessionMessages(sessionDir, sessionId);
  const traces = tracesForChapter(messages, messageId, next?.messageId ?? null);

  if (!scene.sealed || !next) {
    const stored = storedDiffForPath(traces, file.path);
    return diffFromStoredSource(stored, file.path, file.op);
  }

  const store = new IntentBlobStore(sessionDir, sessionId);
  const beforeHead = await loadIntentCheckpointHead(sessionDir, sessionId, messageId, store);
  const afterHead = await loadIntentCheckpointHead(sessionDir, sessionId, next.messageId, store);
  const beforeRef = lookupRef(beforeHead ? { files: beforeHead.files } : null, file.path);
  const afterRef = lookupRef(afterHead ? { files: afterHead.files } : null, file.path);
  const beforeText = beforeRef ? await readIntentCheckpointFile(store, beforeRef, file.path) : null;
  const afterText = afterRef ? await readIntentCheckpointFile(store, afterRef, file.path) : null;
  if (beforeText == null && afterText == null) {
    const stored = storedDiffForPath(traces, file.path);
    if (stored) return diffFromStoredSource(stored, file.path, file.op);
  }
  return buildSceneDiff(beforeText, afterText, file.path, file.op as ChapterSceneOp);
}
