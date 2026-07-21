/**
 * 会话级后台 shell 任务快照（`{sessionId}.bg-tasks.json`）。
 *
 * 与聊天消息同属 session 文件族，供 Desktop / Mobile REST 同步；
 * 权威进程状态仍在 BackgroundTaskManager，本文件为 running 列表的持久镜像。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getBackgroundTaskManagerFor } from '../tools/background-task-manager.js';
import {
  buildBgTaskRunningSnapshot,
  type BgTaskUpdateEntry,
} from '../web/bg-task-pusher.js';

export interface SessionBgTasksFile {
  tasks: BgTaskUpdateEntry[];
  updatedAt: number;
}

function bgTasksFilePath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.bg-tasks.json`);
}

export async function readSessionBgTasks(
  sessionsDir: string,
  sessionId: string,
): Promise<BgTaskUpdateEntry[]> {
  try {
    const raw = await fs.readFile(bgTasksFilePath(sessionsDir, sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as SessionBgTasksFile;
    return Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  } catch {
    return [];
  }
}

export async function writeSessionBgTasks(
  sessionsDir: string,
  sessionId: string,
  tasks: BgTaskUpdateEntry[],
): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
  const file = bgTasksFilePath(sessionsDir, sessionId);
  if (tasks.length === 0) {
    await fs.unlink(file).catch(() => {});
    return;
  }
  const payload: SessionBgTasksFile = {
    tasks,
    updatedAt: Date.now(),
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf-8');
}

export async function clearSessionBgTasks(
  sessionsDir: string,
  sessionId: string,
): Promise<void> {
  await fs.unlink(bgTasksFilePath(sessionsDir, sessionId)).catch(() => {});
}

/** 从 BackgroundTaskManager 刷新 running 快照并落盘。 */
export async function syncSessionBgTasksFromManager(
  sessionsDir: string,
  sessionId: string,
  workDir: string,
): Promise<BgTaskUpdateEntry[]> {
  const mgr = getBackgroundTaskManagerFor(sessionId, workDir);
  const tasks = buildBgTaskRunningSnapshot(mgr);
  await writeSessionBgTasks(sessionsDir, sessionId, tasks);
  return tasks;
}
