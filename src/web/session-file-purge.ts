/**
 * 删除会话时清理磁盘上的全部 session 文件族。
 *
 * 匹配规则（sessions 目录下）：
 * - `{sessionId}` 子目录（checkpoints / analysis / subtasks / artifacts / bg 等）
 * - `{sessionId}.*` 前缀的全部文件（含 .tmp 临时文件）
 *
 * 另清理 imagesCache 与工作区 shadow：`{workspace}/data/sessions/{sessionId}/`
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getDefaultWorkDir } from '../cli/paths.js';
import { loadSessionWorkspace } from '../harness/session-workspace-store.js';
import { clearShellCollab } from '../session/shell-collab-store.js';
import { deleteSessionImagesCache } from './images-cache.js';

async function purgeWorkspaceSessionShadow(sessionsDir: string, sessionId: string): Promise<void> {
  const roots = new Set<string>([path.resolve(getDefaultWorkDir())]);
  try {
    const ws = await loadSessionWorkspace(sessionsDir, sessionId);
    if (ws.lockedRoot?.trim()) roots.add(path.resolve(ws.lockedRoot));
  } catch {
    /* workspace.json 可能已缺失 */
  }

  await Promise.all([...roots].map(async (root) => {
    const shadow = path.join(root, 'data', 'sessions', sessionId);
    await fs.rm(shadow, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }));
}

/** 删除 sessions 目录内与会话 id 关联的全部文件/子目录，并清理 imagesCache 与工作区 shadow。 */
export async function purgeSessionDiskFiles(sessionsDir: string, sessionId: string): Promise<void> {
  // 通用文件族清理只能删除 sidecar；显式调用同时清除进程内 Shell 协作状态。
  await clearShellCollab(sessionId, sessionsDir);
  await purgeWorkspaceSessionShadow(sessionsDir, sessionId);

  const entries = await fs.readdir(sessionsDir).catch((): string[] => []);
  const prefix = `${sessionId}.`;

  for (const name of entries) {
    if (name !== sessionId && !name.startsWith(prefix)) continue;
    const full = path.join(sessionsDir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await fs.rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } else {
        await fs.unlink(full);
      }
    } catch (err) {
      console.warn(
        `[sessions] failed to purge ${full}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  await deleteSessionImagesCache(sessionId).catch(() => {});
}
