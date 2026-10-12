/**
 * 定时任务执行器：把任务提示词（含可选技能引用）投递到任务专属会话的消息队列。
 * 无浏览器连接时用一个已关闭的占位 WS 跑 Harness，进度仍经 broadcastToSession 推给后续订阅者。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { getSkillRegistry } from '../core/skill-registry.js';
import type { ScheduledTask } from '../session/scheduled-task-store.js';
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

/** 专属会话仍在运行，或队列里还有本任务的待执行项。 */
export async function isScheduledTaskBusy(task: ScheduledTask): Promise<boolean> {
  if (sessionProcessing.has(task.sessionId)) return true;
  const queued = await getTaskQueueManager(SESSIONS_DIR).list(task.sessionId);
  return queued.some((item) => item.scheduledTaskId === task.id);
}

export function buildScheduledTaskInput(task: ScheduledTask, knownSkills: Set<string>): TaskEnqueueInput {
  const skills = task.skillFilenames.filter((f) => knownSkills.has(f));
  const text = [...skills.map((f) => `#${f}`), task.prompt].join('\n');
  return {
    text,
    source: 'implicit',
    messageId: randomUUID(),
    ...(skills.length > 0 ? { skills } : {}),
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
