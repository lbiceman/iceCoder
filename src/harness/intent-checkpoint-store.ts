/**
 * Intent Checkpoint 索引与归档存储。
 *
 * 每条 User Message 对应 `{sessionId}/checkpoints/{messageId}.intent.json`。
 * 索引文件：`{sessionId}.checkpoint-index.json`
 *
 * 新写入的归档把文件正文、消息、笔记和 tool trace 按内容哈希放进
 * `{sessionId}/checkpoints/blobs/`。相同内容只存一份；读取时展开回完整快照。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';
import type {
  CheckpointIndexEntry,
  CheckpointIndexFile,
  IntentCheckpointArchive,
} from '../types/intent-checkpoint.js';
import { emptyCheckpointIndex, INTENT_CHECKPOINT_VERSION } from '../types/intent-checkpoint.js';
import {
  isProjectCheckpointV3,
  type ProjectCheckpointV3,
} from '../types/runtime-checkpoint.js';
import { adaptLegacyCheckpoint } from './legacy-checkpoint-adapter.js';
import { remapPathToWorkspace } from './workspace-snapshot.js';
import { extractLikelyWritePathsFromCommand } from './workspace-command-touch.js';
import {
  absentWorkspacePathsFromArchive,
  externalizeIntentCheckpoint,
  IntentCheckpointCorruptError,
  materializeIntentCheckpoint,
  sweepUnreferencedIntentBlobs,
} from './intent-checkpoint-blobs.js';

export { IntentCheckpointCorruptError } from './intent-checkpoint-blobs.js';

function indexPath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.checkpoint-index.json`);
}

function checkpointsDir(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, sessionId, 'checkpoints');
}

const SAFE_MESSAGE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** messageId 会拼进文件名；含路径分隔符、盘符等字符的 id 不得落盘。 */
export function isSafeIntentMessageId(messageId: string | null | undefined): messageId is string {
  return typeof messageId === 'string' && SAFE_MESSAGE_ID_RE.test(messageId);
}

function archivePath(sessionDir: string, sessionId: string, messageId: string): string {
  if (!isSafeIntentMessageId(messageId)) {
    throw new Error(`[intent-checkpoint] unsafe messageId: ${JSON.stringify(messageId)}`);
  }
  return path.join(checkpointsDir(sessionDir, sessionId), `${messageId}.intent.json`);
}

/** 索引里的 archiveFileName 可能来自旧版本或被篡改，删除前必须确认是纯文件名。 */
function archiveFilePathFromIndex(sessionDir: string, sessionId: string, fileName: string): string | null {
  if (!fileName || path.basename(fileName) !== fileName || !SAFE_MESSAGE_ID_RE.test(fileName)) return null;
  return path.join(checkpointsDir(sessionDir, sessionId), fileName);
}

const indexWriteChains = new Map<string, Promise<void>>();

export function getCheckpointIndexLockCount(): number {
  return indexWriteChains.size;
}

function withCheckpointIndexLock<T>(
  sessionDir: string,
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(indexPath(sessionDir, sessionId)).toLowerCase();
  const run = () => fn();
  const next = (indexWriteChains.get(key) ?? Promise.resolve()).then(run, run);
  const tail = next.then(() => undefined, () => undefined);
  indexWriteChains.set(key, tail);
  void tail.then(() => {
    if (indexWriteChains.get(key) === tail) indexWriteChains.delete(key);
  });
  return next;
}

function normalizeTouchedPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** 写入类工具成功后应记入 sessionTouchedPaths 的相对路径。 */
export function collectSessionTouchedPaths(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string[] {
  if (!args || typeof args !== 'object') return [];
  const out: string[] = [];
  const add = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const normalized = normalizeTouchedPath(raw.trim());
    if (normalized) out.push(normalized);
  };

  if (
    toolName === 'write_file'
    || toolName === 'edit_file'
    || toolName === 'append_file'
    || toolName === 'patch_file'
    || toolName === 'batch_edit_file'
  ) {
    add(args.path ?? args.file_path);
    return out;
  }

  if (toolName === 'fs_operation') {
    const op = String(args.operation || '').toLowerCase();
    if (op === 'list') return [];
    add(args.path ?? args.filePath);
    if (op === 'move' || op === 'copy') add(args.target);
    return out;
  }

  if (toolName === 'run_command' || toolName === 'shell_exec') {
    const action = String(args.action || '').toLowerCase();
    if (action === 'check' || action === 'list' || action === 'stop') return [];
    const command = typeof args.command === 'string'
      ? args.command
      : typeof args.cmd === 'string' ? args.cmd : '';
    for (const p of extractLikelyWritePathsFromCommand(command)) add(p);
    return out;
  }

  return [];
}

export async function loadCheckpointIndex(
  sessionDir: string,
  sessionId: string,
): Promise<CheckpointIndexFile> {
  try {
    const raw = await fs.readFile(indexPath(sessionDir, sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as CheckpointIndexFile;
    if (parsed?.version === 1 && Array.isArray(parsed.entries)) {
      return parsed;
    }
  } catch {
    /* missing */
  }
  return emptyCheckpointIndex();
}

async function saveCheckpointIndex(
  sessionDir: string,
  sessionId: string,
  index: CheckpointIndexFile,
): Promise<void> {
  await writeFileAtomic(indexPath(sessionDir, sessionId), JSON.stringify(index, null, 2));
}

export async function loadIntentCheckpoint(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<IntentCheckpointArchive | null> {
  let raw: string;
  try {
    raw = await fs.readFile(archivePath(sessionDir, sessionId, messageId), 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const header = parsed as { version?: unknown; messageId?: unknown };
  if (header.version !== INTENT_CHECKPOINT_VERSION || header.messageId !== messageId) return null;
  try {
    const archive = await materializeIntentCheckpoint(sessionDir, sessionId, parsed);
    if (archive.messageId !== messageId) return null;
    return {
      ...archive,
      projectCheckpoint: resolveProjectCheckpoint(archive, sessionId),
    };
  } catch (err) {
    if (err instanceof IntentCheckpointCorruptError) {
      console.warn(`[intent-checkpoint] ${err.message}`);
      throw err;
    }
    const wrapped = new IntentCheckpointCorruptError(
      `检查点 ${messageId} 内容无法展开。`,
      { cause: err },
    );
    console.warn(`[intent-checkpoint] ${wrapped.message}`);
    throw wrapped;
  }
}

/** 仅重写已有归档内容，不改变 checkpoint 索引顺序或 cursor。 */
export async function rewriteIntentCheckpoint(
  sessionDir: string,
  sessionId: string,
  archive: IntentCheckpointArchive,
): Promise<void> {
  const archiveToWrite = withoutLegacyRuntime(archive);
  const dest = archivePath(sessionDir, sessionId, archive.messageId);
  await withCheckpointIndexLock(sessionDir, sessionId, async () => {
    try {
      await writeExternalizedArchive(sessionDir, sessionId, dest, archiveToWrite);
    } finally {
      await sweepIntentBlobsQuietly(sessionDir, sessionId);
    }
  });
}

export interface SaveIntentCheckpointInput {
  sessionDir: string;
  sessionId: string;
  archive: IntentCheckpointArchive;
}

/** 保存 Intent Checkpoint 并更新索引 cursor（不覆盖已有同 messageId 条目的位置）。 */
export async function saveIntentCheckpoint(input: SaveIntentCheckpointInput): Promise<void> {
  const { sessionDir, sessionId, archive } = input;
  const archiveToWrite = withoutLegacyRuntime(archive);
  const fileName = `${archive.messageId}.intent.json`;
  const dest = archivePath(sessionDir, sessionId, archive.messageId);

  await withCheckpointIndexLock(sessionDir, sessionId, async () => {
    try {
      await writeExternalizedArchive(sessionDir, sessionId, dest, archiveToWrite);
      const index = await loadCheckpointIndex(sessionDir, sessionId);
      const existingIdx = index.entries.findIndex((e) => e.messageId === archive.messageId);
      const entry: CheckpointIndexEntry = {
        messageId: archive.messageId,
        archiveFileName: fileName,
        createdAt: archive.createdAt,
        userMessageTime: archive.userMessageTime,
      };
      if (existingIdx >= 0) {
        index.entries[existingIdx] = entry;
      } else {
        index.entries.push(entry);
      }
      index.cursorMessageId = archive.messageId;
      index.cursorRestored = false;
      // 不把归档 trackedPaths（含用户提示路径）并进 live manifest，避免会话修改列表掺未写入文件。
      await saveCheckpointIndex(sessionDir, sessionId, index);
    } finally {
      await sweepIntentBlobsQuietly(sessionDir, sessionId);
    }
  });
}

export function listCheckpointMessageIds(index: CheckpointIndexFile): string[] {
  return index.entries.map((e) => e.messageId);
}

export async function loadCheckpointMessageIds(
  sessionDir: string,
  sessionId: string,
): Promise<string[]> {
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  return listCheckpointMessageIds(index);
}

export async function loadSessionTouchedPaths(
  sessionDir: string,
  sessionId: string,
): Promise<string[]> {
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  return index.sessionTouchedPaths ?? [];
}

/** 会话内首次写入后立刻记入 manifest，供后续 checkpoint 快照与会话修改列表。 */
export async function touchSessionTouchedPath(
  sessionDir: string,
  sessionId: string,
  relPath: string,
): Promise<void> {
  await touchSessionTouchedPaths(sessionDir, sessionId, [relPath]);
}

export async function touchSessionTouchedPaths(
  sessionDir: string,
  sessionId: string,
  relPaths: string[],
): Promise<void> {
  const incoming = [...new Set(
    relPaths.map((p) => normalizeTouchedPath(String(p || '').trim())).filter(Boolean),
  )];
  if (!incoming.length) return;
  await withCheckpointIndexLock(sessionDir, sessionId, async () => {
    const index = await loadCheckpointIndex(sessionDir, sessionId);
    const manifest = new Set(index.sessionTouchedPaths ?? []);
    let changed = false;
    for (const normalized of incoming) {
      if (manifest.has(normalized)) continue;
      manifest.add(normalized);
      changed = true;
    }
    if (!changed) return;
    index.sessionTouchedPaths = [...manifest];
    await saveCheckpointIndex(sessionDir, sessionId, index);
  });
}

/**
 * 回滚截断后：只保留「当前 live ∩ cursor 归档 trackedPaths」。
 * 这样丢掉截断轮次的新写入，又不会把仅出现在提示文本里的路径灌进列表。
 */
async function syncTouchedPathsToCursorArchive(
  sessionDir: string,
  sessionId: string,
  index: CheckpointIndexFile,
): Promise<void> {
  if (!index.cursorMessageId) {
    index.sessionTouchedPaths = [];
    return;
  }
  const archive = await loadIntentCheckpoint(sessionDir, sessionId, index.cursorMessageId);
  const root = archive?.workspaceRoot;
  const archivePaths = new Set<string>();
  for (const raw of archive?.trackedPaths ?? []) {
    const norm = normalizeTouchedPath(raw);
    const remapped = root ? (remapPathToWorkspace(root, norm) ?? norm) : norm;
    if (remapped) archivePaths.add(remapped);
  }
  const live = (index.sessionTouchedPaths ?? [])
    .map((p) => normalizeTouchedPath(p))
    .map((p) => (root ? (remapPathToWorkspace(root, p) ?? p) : p))
    .filter(Boolean);
  // 旧索引若还没有 live（只有归档），回退到归档路径，避免回滚后列表被清空。
  index.sessionTouchedPaths = live.length
    ? live.filter((p) => archivePaths.has(p))
    : [...archivePaths];
}

/** 将 cursor 移动到指定 messageId（Restore 完成后调用）。 */
export async function setCheckpointCursor(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  await withCheckpointIndexLock(sessionDir, sessionId, async () => {
    const index = await loadCheckpointIndex(sessionDir, sessionId);
    if (!index.entries.some((e) => e.messageId === messageId)) {
      throw new Error(`Checkpoint index has no entry for messageId=${messageId}`);
    }
    index.cursorMessageId = messageId;
    index.cursorRestored = true;
    await saveCheckpointIndex(sessionDir, sessionId, index);
  });
}

/**
 * 目标检查点之后「当时还不存在」的路径，供 restore 删除新建文件。
 * 只看后续归档里 content === null 的快照键；trackedPaths 含只读/提示路径，不能当删除名单。
 */
export async function collectTrackedPathsAfterMessage(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<string[]> {
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  const targetIdx = index.entries.findIndex((e) => e.messageId === messageId);
  if (targetIdx < 0) return [];

  const paths = new Set<string>();
  for (let i = targetIdx + 1; i < index.entries.length; i++) {
    const entry = index.entries[i];
    for (const absent of await absentWorkspacePaths(sessionDir, sessionId, entry.messageId)) {
      paths.add(absent);
    }
  }
  return [...paths];
}

/** 删除指定 messageId 及其之后的 checkpoint 条目与归档（时间线截断时调用）。 */
export async function truncateCheckpointsFrom(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  let toRemove: CheckpointIndexEntry[] = [];
  await withCheckpointIndexLock(sessionDir, sessionId, async () => {
    const index = await loadCheckpointIndex(sessionDir, sessionId);
    const targetIdx = index.entries.findIndex((e) => e.messageId === messageId);
    if (targetIdx < 0) return;

    toRemove = index.entries.slice(targetIdx);
    index.entries = index.entries.slice(0, targetIdx);
    index.cursorMessageId = index.entries.length > 0
      ? index.entries[index.entries.length - 1].messageId
      : null;
    index.cursorRestored = false;
    await syncTouchedPathsToCursorArchive(sessionDir, sessionId, index);
    await saveCheckpointIndex(sessionDir, sessionId, index);
    for (const entry of toRemove) {
      await unlinkArchiveFromIndex(sessionDir, sessionId, entry);
    }
    await sweepIntentBlobsQuietly(sessionDir, sessionId);
  });
}

/** 删除单个 checkpoint 条目与归档，保留其后的 checkpoint。不回滚工作区，故不改 live manifest。 */
export async function removeCheckpoint(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  let removed: CheckpointIndexEntry | undefined;
  await withCheckpointIndexLock(sessionDir, sessionId, async () => {
    const index = await loadCheckpointIndex(sessionDir, sessionId);
    const targetIdx = index.entries.findIndex((entry) => entry.messageId === messageId);
    if (targetIdx < 0) return;

    [removed] = index.entries.splice(targetIdx, 1);
    if (index.cursorMessageId === messageId) {
      index.cursorMessageId = targetIdx > 0
        ? index.entries[targetIdx - 1].messageId
        : null;
      index.cursorRestored = false;
    }
    await saveCheckpointIndex(sessionDir, sessionId, index);
    if (removed) await unlinkArchiveFromIndex(sessionDir, sessionId, removed);
    await sweepIntentBlobsQuietly(sessionDir, sessionId);
  });
}

/** 删除 cursor 之后的 checkpoint 条目与归档（Restore 后截断时间线）。 */
export async function truncateCheckpointsAfter(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  let toRemove: CheckpointIndexEntry[] = [];
  await withCheckpointIndexLock(sessionDir, sessionId, async () => {
    const index = await loadCheckpointIndex(sessionDir, sessionId);
    const targetIdx = index.entries.findIndex((e) => e.messageId === messageId);
    if (targetIdx < 0) return;

    toRemove = index.entries.slice(targetIdx + 1);
    index.entries = index.entries.slice(0, targetIdx + 1);
    index.cursorMessageId = messageId;
    index.cursorRestored = true;
    await syncTouchedPathsToCursorArchive(sessionDir, sessionId, index);
    await saveCheckpointIndex(sessionDir, sessionId, index);
    for (const entry of toRemove) {
      await unlinkArchiveFromIndex(sessionDir, sessionId, entry);
    }
    await sweepIntentBlobsQuietly(sessionDir, sessionId);
  });
}

async function writeExternalizedArchive(
  sessionDir: string,
  sessionId: string,
  dest: string,
  archive: IntentCheckpointArchive,
): Promise<void> {
  const stored = await externalizeIntentCheckpoint(sessionDir, sessionId, archive);
  await writeFileAtomic(dest, JSON.stringify(stored));
}

async function sweepIntentBlobsQuietly(sessionDir: string, sessionId: string): Promise<void> {
  try {
    await sweepUnreferencedIntentBlobs(sessionDir, sessionId);
  } catch (err) {
    console.warn(
      '[intent-checkpoint] blob 回收失败:',
      err instanceof Error ? err.message : err,
    );
  }
}

/** 后续归档里 content === null 的路径。不展开文件正文。格式损坏时抛出，避免回滚漏删。 */
async function absentWorkspacePaths(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<string[]> {
  if (!isSafeIntentMessageId(messageId)) return [];
  let raw: string;
  try {
    raw = await fs.readFile(archivePath(sessionDir, sessionId, messageId), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new IntentCheckpointCorruptError(
      `检查点 ${messageId} 无法解析，已停止回滚以避免误删文件。`,
      { cause: err },
    );
  }
  const absent = absentWorkspacePathsFromArchive(parsed);
  if (absent === null) {
    throw new IntentCheckpointCorruptError(
      `检查点 ${messageId} 格式无法识别，已停止回滚以避免误删文件。`,
    );
  }
  return absent;
}

async function unlinkArchiveFromIndex(
  sessionDir: string,
  sessionId: string,
  entry: CheckpointIndexEntry,
): Promise<void> {
  const file = archiveFilePathFromIndex(sessionDir, sessionId, entry.archiveFileName);
  if (!file) {
    console.warn(`[intent-checkpoint] 跳过非法 archiveFileName: ${JSON.stringify(entry.archiveFileName)}`);
    return;
  }
  try {
    await fs.unlink(file);
  } catch {
    /* already gone */
  }
}

export function intentCheckpointArchivePath(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): string {
  return archivePath(sessionDir, sessionId, messageId);
}

export async function readSessionCheckpointJson(
  sessionDir: string,
  sessionId: string,
): Promise<import('../types/runtime-checkpoint.js').ProjectCheckpointV3 | null> {
  const { ProjectCheckpointStore } = await import('./project-checkpoint-store.js');
  return new ProjectCheckpointStore({ sessionDir, sessionId }).load();
}

/** @deprecated Use ProjectCheckpointStore.save. Kept for restore rollback compatibility. */
export async function writeSessionCheckpointJson(
  sessionDir: string,
  sessionId: string,
  checkpoint:
    | import('./checkpoint-engine.js').CombinedCheckpointFile
    | import('../types/runtime-checkpoint.js').ProjectCheckpointV3,
): Promise<void> {
  const { ProjectCheckpointStore } = await import('./project-checkpoint-store.js');
  const store = new ProjectCheckpointStore({ sessionDir, sessionId });
  const project = isProjectCheckpointV3(checkpoint)
    ? checkpoint
    : adaptLegacyCheckpoint(checkpoint, { sessionId });
  await store.restore(project);
}

function resolveProjectCheckpoint(
  archive: IntentCheckpointArchive,
  sessionId?: string,
): ProjectCheckpointV3 | null {
  if (isProjectCheckpointV3(archive.projectCheckpoint)) return archive.projectCheckpoint;
  const hasLegacyRuntime = Boolean(archive.combinedCheckpoint)
    || (
      typeof archive.sessionNotesContent === 'string'
      && archive.sessionNotesContent.includes('```icecoder-runtime')
    );
  if (!hasLegacyRuntime) return archive.projectCheckpoint ?? null;
  const adapted = adaptLegacyCheckpoint(archive, {
    sessionId: sessionId ?? archive.sessionId,
  });
  return isProjectCheckpointV3(adapted) ? adapted : null;
}

function withoutLegacyRuntime(archive: IntentCheckpointArchive): IntentCheckpointArchive {
  const projectCheckpoint = resolveProjectCheckpoint(archive);
  const next: IntentCheckpointArchive = { ...archive, projectCheckpoint };
  if (archive.combinedCheckpoint === undefined) {
    delete next.combinedCheckpoint;
  }
  return next;
}
