/**
 * 定时任务执行器：把任务提示词（含技能引用、图片、文件引用路径）投递到任务专属会话的消息队列。
 * 无浏览器连接时用一个已关闭的占位 WS 跑 Harness，进度仍经 broadcastToSession 推给后续订阅者。
 * 定时任务轮次无人值守：确认一律自动通过（见 chat-ws-confirm 的 setSessionUnattended）。
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
import { buildSessionImageApiUrl, persistUploadedImageFiles, resolveSessionImageFile } from './images-cache.js';

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
  /** 执行前按需轮换专属会话，返回（可能已换绑的）任务。 */
  rotateSession?: (task: ScheduledTask) => Promise<ScheduledTask>;
}

/** 专属会话的消息文件（UI + 结构化历史）超过该大小时，下次执行前换新会话。 */
export const SCHEDULED_TASK_SESSION_MAX_BYTES = 20 * 1024 * 1024;

export interface ScheduledTaskSessionRotationDeps {
  store: Pick<ScheduledTaskStore, 'rebindSession'>;
  createSession: (title: string) => Promise<{ id: string }>;
  sessionBytes?: (sessionId: string) => Promise<number>;
  /** 把旧会话里的任务图片复制到新会话，返回新 URL；失败返回 null。 */
  copyImage?: (url: string, fromSessionId: string, toSessionId: string) => Promise<string | null>;
  maxBytes?: number;
}

async function defaultSessionBytes(sessionId: string): Promise<number> {
  let total = 0;
  for (const suffix of ['.json', '.structured.json']) {
    try {
      total += (await fs.stat(path.join(SESSIONS_DIR, `${sessionId}${suffix}`))).size;
    } catch {
      /* 文件缺失按 0 计 */
    }
  }
  return total;
}

const SESSION_IMAGE_URL_RE = /^\/api\/sessions\/[^/]+\/images\/([^/?#]+)$/;

async function defaultCopyImage(url: string, fromSessionId: string, toSessionId: string): Promise<string | null> {
  const match = SESSION_IMAGE_URL_RE.exec(url);
  if (!match) return null;
  const src = resolveSessionImageFile(fromSessionId, decodeURIComponent(match[1]!));
  if (!src) return null;
  const [copied] = await persistUploadedImageFiles([src], toSessionId);
  return copied ? buildSessionImageApiUrl(toSessionId, copied.absolutePath) : null;
}

/**
 * 会话过大时新建专属会话、把任务图片复制过去并换绑。旧会话原样保留（由用户自行处理），
 * 图片复制失败时沿用旧 URL。新会话不继承旧会话的对话历史。
 */
export async function rotateScheduledTaskSessionIfOversized(
  task: ScheduledTask,
  deps: ScheduledTaskSessionRotationDeps,
): Promise<ScheduledTask> {
  const sessionBytes = deps.sessionBytes ?? defaultSessionBytes;
  const copyImage = deps.copyImage ?? defaultCopyImage;
  const maxBytes = deps.maxBytes ?? SCHEDULED_TASK_SESSION_MAX_BYTES;
  if ((await sessionBytes(task.sessionId)) < maxBytes) return task;

  const session = await deps.createSession(`定时任务：${task.name}`);
  const images: string[] = [];
  for (const url of task.images) {
    images.push((await copyImage(url, task.sessionId, session.id).catch(() => null)) ?? url);
  }
  return deps.store.rebindSession(task.id, session.id, images);
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

  return async function executeScheduledTask(scheduled: ScheduledTask): Promise<void> {
    if (!(await sessionExists(scheduled.sessionId))) {
      throw new Error('任务会话不存在，请删除任务后重新创建');
    }
    const task = deps.rotateSession ? await deps.rotateSession(scheduled) : scheduled;
    const input = buildScheduledTaskInput(task, await listSkillFilenames());
    const ws = pickSessionWs(task.sessionId) ?? headlessWs;
    await persistUserMessage(task.sessionId, ws, input);
    await enqueue(deps.chatDeps, task.sessionId, ws, input);
  };
}
