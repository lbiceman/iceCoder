/**
 * 定时任务执行器：把任务提示词（含技能引用、图片、文件引用路径）投递到任务专属会话的消息队列。
 * 无浏览器连接时用一个已关闭的占位 WS 跑 Harness，进度仍经 broadcastToSession 推给后续订阅者。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { getSkillRegistry } from '../core/skill-registry.js';
import type { ScheduledTask, ScheduledTaskStore } from '../session/scheduled-task-store.js';
import { getTaskQueueManager, type TaskEnqueueInput } from '../session/task-queue.js';
import { pickSessionWs } from './chat-ws-broadcast.js';
import {
  enqueueAndMaybeKickoff,
  persistImplicitQueuedUserMessage,
  type ChatRunDeps,
} from './chat-ws-loop.js';
import { SESSIONS_DIR, sessionProcessing } from './chat-ws-runtime.js';

const headlessWs = {
  readyState: WebSocket.CLOSED,
  send() {},
} as unknown as WebSocket;

export interface ScheduledTaskExecutorDeps {
  chatDeps: ChatRunDeps;
  listSkillFilenames?: () => Promise<Set<string>>;
  sessionExists?: (sessionId: string) => Promise<boolean>;
  enqueue?: typeof enqueueAndMaybeKickoff;
  persistUserMessage?: typeof persistImplicitQueuedUserMessage;
}

async function defaultListSkillFilenames(): Promise<Set<string>> {
  const skills = await getSkillRegistry().listSkills();
  return new Set(skills.map((s) => s.filename));
}

async function defaultSessionExists(sessionId: string): Promise<boolean> {
  try {
    await fs.access(path.join(SESSIONS_DIR, `${sessionId}.json`));
    return true;
  } catch {
    return false;
  }
}

export const SCHEDULED_TASK_SESSION_DELETED = '任务会话已被删除，任务已停用';

/** 专属会话被删除后停用绑定的任务，避免每个周期都报「会话不存在」。返回停用的任务数。 */
export async function disableScheduledTasksForSession(
  store: Pick<ScheduledTaskStore, 'list' | 'update' | 'updateRunState'>,
  sessionId: string,
): Promise<number> {
  const bound = (await store.list()).filter((t) => t.sessionId === sessionId);
  for (const task of bound) {
    if (task.enabled) await store.update(task.id, { enabled: false });
    await store.updateRunState(task.id, { lastStatus: 'error', lastError: SCHEDULED_TASK_SESSION_DELETED });
  }
  return bound.length;
}

/** 专属会话仍在运行，或队列里还有本任务的待执行项。 */
export async function isScheduledTaskBusy(task: ScheduledTask): Promise<boolean> {
  if (sessionProcessing.has(task.sessionId)) return true;
  const queued = await getTaskQueueManager(SESSIONS_DIR).list(task.sessionId);
  return queued.some((item) => item.scheduledTaskId === task.id);
}

export function buildScheduledTaskInput(task: ScheduledTask, knownSkills: Set<string>): TaskEnqueueInput {
  const skills = task.skillFilenames.filter((f) => knownSkills.has(f));
  const filePaths = (task.files ?? []).map((f) => f.path);
  const images = task.images ?? [];
  const text = [...skills.map((f) => `#${f}`), ...filePaths, task.prompt].join('\n');
  return {
    text,
    source: 'implicit',
    messageId: randomUUID(),
    ...(skills.length > 0 ? { skills } : {}),
    ...(filePaths.length > 0 ? { referencePaths: filePaths } : {}),
    ...(images.length > 0 ? { images: images.slice() } : {}),
    scheduledTaskId: task.id,
  };
}

export function createScheduledTaskExecutor(deps: ScheduledTaskExecutorDeps) {
  const listSkillFilenames = deps.listSkillFilenames ?? defaultListSkillFilenames;
  const sessionExists = deps.sessionExists ?? defaultSessionExists;
  const enqueue = deps.enqueue ?? enqueueAndMaybeKickoff;
  const persistUserMessage = deps.persistUserMessage ?? persistImplicitQueuedUserMessage;

  return async function executeScheduledTask(task: ScheduledTask): Promise<void> {
    if (!(await sessionExists(task.sessionId))) {
      throw new Error('任务会话不存在，请删除任务后重新创建');
    }
    const input = buildScheduledTaskInput(task, await listSkillFilenames());
    const ws = pickSessionWs(task.sessionId) ?? headlessWs;
    await persistUserMessage(task.sessionId, ws, input);
    await enqueue(deps.chatDeps, task.sessionId, ws, input);
  };
}
