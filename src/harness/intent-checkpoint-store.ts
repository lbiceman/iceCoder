/**
 * Intent Checkpoint 索引与归档存储。
 *
 * 每条 User Message 对应 `{sessionId}/checkpoints/{messageId}.intent.json`。
 * 索引文件：`{sessionId}.checkpoint-index.json`
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  CheckpointIndexEntry,
  CheckpointIndexFile,
  IntentCheckpointArchive,
} from '../types/intent-checkpoint.js';
import { emptyCheckpointIndex, INTENT_CHECKPOINT_VERSION } from '../types/intent-checkpoint.js';

function indexPath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.checkpoint-index.json`);
}

function checkpointsDir(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, sessionId, 'checkpoints');
}

function archivePath(sessionDir: string, sessionId: string, messageId: string): string {
  return path.join(checkpointsDir(sessionDir, sessionId), `${messageId}.intent.json`);
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
  await fs.mkdir(sessionDir, { recursive: true });
  const tmp = `${indexPath(sessionDir, sessionId)}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2), 'utf-8');
  await fs.rename(tmp, indexPath(sessionDir, sessionId));
}

export async function loadIntentCheckpoint(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<IntentCheckpointArchive | null> {
  try {
    const raw = await fs.readFile(archivePath(sessionDir, sessionId, messageId), 'utf-8');
    const parsed = JSON.parse(raw) as IntentCheckpointArchive;
    if (parsed?.version === INTENT_CHECKPOINT_VERSION && parsed.messageId === messageId) {
      return parsed;
    }
  } catch {
    /* missing */
  }
  return null;
}

export interface SaveIntentCheckpointInput {
  sessionDir: string;
  sessionId: string;
  archive: IntentCheckpointArchive;
}

/** 保存 Intent Checkpoint 并更新索引 cursor（不覆盖已有同 messageId 条目）。 */
export async function saveIntentCheckpoint(input: SaveIntentCheckpointInput): Promise<void> {
  const { sessionDir, sessionId, archive } = input;
  await fs.mkdir(checkpointsDir(sessionDir, sessionId), { recursive: true });
  const fileName = `${archive.messageId}.intent.json`;
  const dest = archivePath(sessionDir, sessionId, archive.messageId);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(archive, null, 2), 'utf-8');
  await fs.rename(tmp, dest);

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
  const manifest = new Set(index.sessionTouchedPaths ?? []);
  for (const p of archive.trackedPaths) manifest.add(p.replace(/\\/g, '/'));
  index.sessionTouchedPaths = [...manifest];
  await saveCheckpointIndex(sessionDir, sessionId, index);
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

/** 会话内首次写入/读取后立刻记入 manifest，供后续 checkpoint 快照。 */
export async function touchSessionTouchedPath(
  sessionDir: string,
  sessionId: string,
  relPath: string,
): Promise<void> {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return;
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  const manifest = new Set(index.sessionTouchedPaths ?? []);
  if (manifest.has(normalized)) return;
  manifest.add(normalized);
  index.sessionTouchedPaths = [...manifest];
  await saveCheckpointIndex(sessionDir, sessionId, index);
}

/** 将 cursor 移动到指定 messageId（Restore 完成后调用）。 */
export async function setCheckpointCursor(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  if (!index.entries.some((e) => e.messageId === messageId)) {
    throw new Error(`Checkpoint index has no entry for messageId=${messageId}`);
  }
  index.cursorMessageId = messageId;
  await saveCheckpointIndex(sessionDir, sessionId, index);
}

/** 获取 cursor 之后的所有 trackedPaths（用于 workspace 清理）。 */
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
    const archive = await loadIntentCheckpoint(sessionDir, sessionId, entry.messageId);
    if (archive) {
      for (const p of archive.trackedPaths) paths.add(p);
    }
  }
  return [...paths];
}

/** 删除指定 messageId 及其之后的 checkpoint 条目与归档（删除用户消息时调用）。 */
export async function truncateCheckpointsFrom(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  const targetIdx = index.entries.findIndex((e) => e.messageId === messageId);
  if (targetIdx < 0) return;

  const toRemove = index.entries.slice(targetIdx);
  index.entries = index.entries.slice(0, targetIdx);
  index.cursorMessageId = index.entries.length > 0
    ? index.entries[index.entries.length - 1].messageId
    : null;
  await saveCheckpointIndex(sessionDir, sessionId, index);

  for (const entry of toRemove) {
    try {
      await fs.unlink(path.join(checkpointsDir(sessionDir, sessionId), entry.archiveFileName));
    } catch {
      /* already gone */
    }
  }
}

/** 删除 cursor 之后的 checkpoint 条目与归档（Restore 后截断时间线）。 */
export async function truncateCheckpointsAfter(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  const targetIdx = index.entries.findIndex((e) => e.messageId === messageId);
  if (targetIdx < 0) return;

  const toRemove = index.entries.slice(targetIdx + 1);
  index.entries = index.entries.slice(0, targetIdx + 1);
  index.cursorMessageId = messageId;
  await saveCheckpointIndex(sessionDir, sessionId, index);

  for (const entry of toRemove) {
    try {
      await fs.unlink(path.join(checkpointsDir(sessionDir, sessionId), entry.archiveFileName));
    } catch {
      /* already gone */
    }
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
): Promise<import('./checkpoint-engine.js').CombinedCheckpointFile | null> {
  const p = path.join(sessionDir, `${sessionId}.checkpoint.json`);
  try {
    const raw = await fs.readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeSessionCheckpointJson(
  sessionDir: string,
  sessionId: string,
  combined: import('./checkpoint-engine.js').CombinedCheckpointFile,
): Promise<void> {
  const p = path.join(sessionDir, `${sessionId}.checkpoint.json`);
  await fs.mkdir(sessionDir, { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(combined, null, 2), 'utf-8');
  await fs.rename(tmp, p);
}
