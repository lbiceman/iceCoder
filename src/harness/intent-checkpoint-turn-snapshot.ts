/**
 * 单轮 Harness 运行期间的「写入前」工作区快照。
 * Intent Checkpoint 在用户消息时捕获，早于工具写文件；此处补录本轮首次写入前的磁盘内容。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  loadIntentCheckpoint,
  saveIntentCheckpoint,
} from './intent-checkpoint-store.js';
import type { IntentCheckpointArchive } from '../types/intent-checkpoint.js';
import { toPosixRel } from './workspace-snapshot.js';

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'batch_edit_file',
  'patch_file',
]);

interface ActiveTurn {
  sessionId: string;
  messageId: string;
  workspaceRoot: string;
}

const turnBuffers = new Map<string, Record<string, string | null>>();
/**
 * 每个会话各自的「当前活跃回合」。
 * 进程内可能同时跑多个会话（Web 多标签 / 移动端并发），单个全局 activeTurn
 * 会被后一回合覆盖，导致写前快照挂到错误的会话；故按 sessionId 维护。
 */
const activeTurns = new Map<string, ActiveTurn>();

function turnKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

export function isIntentCheckpointWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName);
}

export function beginIntentCheckpointTurn(
  sessionId: string,
  messageId: string,
  workspaceRoot: string,
): void {
  activeTurns.set(sessionId, { sessionId, messageId, workspaceRoot });
  turnBuffers.set(turnKey(sessionId, messageId), {});
}

export function clearIntentCheckpointTurn(sessionId: string, messageId: string): void {
  turnBuffers.delete(turnKey(sessionId, messageId));
  const active = activeTurns.get(sessionId);
  if (active?.messageId === messageId) {
    activeTurns.delete(sessionId);
  }
}

/** 清理某会话的全部回合状态（会话删除时调用，避免陈旧 activeTurn / 缓冲残留）。 */
export function clearIntentCheckpointTurnsForSession(sessionId: string): void {
  activeTurns.delete(sessionId);
  const prefix = `${sessionId}:`;
  for (const key of turnBuffers.keys()) {
    if (key.startsWith(prefix)) turnBuffers.delete(key);
  }
}

async function readWorkspaceFileOrNull(
  workspaceRoot: string,
  relPath: string,
): Promise<string | null> {
  const root = path.resolve(workspaceRoot);
  const normalized = relPath.replace(/\\/g, '/');
  const abs = path.join(root, ...normalized.split('/'));
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return null;
    return await fs.readFile(abs, 'utf-8');
  } catch {
    return null;
  }
}

/** 在首次写工具执行前记录该路径的写入前内容（仅当前 active turn）。 */
export async function capturePreTurnWriteSnapshot(
  sessionId: string | undefined,
  workspaceRoot: string,
  relPath: string | undefined,
): Promise<void> {
  if (!sessionId || !relPath?.trim()) return;
  const activeTurn = activeTurns.get(sessionId);
  if (!activeTurn) return;
  const normalized = relPath.replace(/\\/g, '/');
  const posix = toPosixRel(workspaceRoot, path.resolve(workspaceRoot, ...normalized.split('/')));
  const rel = posix ?? normalized;
  const key = turnKey(activeTurn.sessionId, activeTurn.messageId);
  const buf = turnBuffers.get(key);
  if (!buf || rel in buf) return;
  buf[rel] = await readWorkspaceFileOrNull(workspaceRoot, rel);
}

/** 将本轮写入前快照合并进 Intent Checkpoint 归档（Harness 本轮结束后调用）。 */
export async function finalizeIntentCheckpointTurn(
  sessionDir: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  const key = turnKey(sessionId, messageId);
  const buf = turnBuffers.get(key);
  clearIntentCheckpointTurn(sessionId, messageId);
  if (!buf || Object.keys(buf).length === 0) return;

  const archive = await loadIntentCheckpoint(sessionDir, sessionId, messageId);
  if (!archive) return;

  const mergedFiles = { ...archive.workspaceFiles };
  const mergedTracked = new Set(archive.trackedPaths.map((p) => p.replace(/\\/g, '/')));
  for (const [rel, content] of Object.entries(buf)) {
    const normalized = rel.replace(/\\/g, '/');
    if (!(normalized in mergedFiles)) {
      mergedFiles[normalized] = content;
    }
    mergedTracked.add(normalized);
  }

  const next: IntentCheckpointArchive = {
    ...archive,
    workspaceFiles: mergedFiles,
    trackedPaths: [...mergedTracked],
  };
  await saveIntentCheckpoint({ sessionDir, sessionId, archive: next });
}
