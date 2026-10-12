/**
 * 定时任务执行器：把任务提示词（含技能引用、图片、文件引用路径）投递到任务专属会话的消息队列。
 * 无浏览器连接时用一个已关闭的占位 WS 跑 Harness，进度仍经 broadcastToSession 推给后续订阅者。
 * 定时任务轮次无人值守：确认一律自动通过（见 chat-ws-confirm 的 setSessionUnattended）。
 *
 * 专属会话只在执行时创建：新建任务时没有会话（sessionId 为空），首次执行前才新建；
 * 用户删除专属会话后任务不受影响、照常调度，下次执行时再新建。
 */

import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { getImagesCacheSessionDir } from '../cli/paths.js';
import { getSkillRegistry } from '../core/skill-registry.js';
import type { ScheduledTask, ScheduledTaskFile, ScheduledTaskStore } from '../session/scheduled-task-store.js';
import { getTaskQueueManager, type TaskEnqueueInput } from '../session/task-queue.js';
import { pickSessionWs } from './chat-ws-broadcast.js';
import {
  enqueueAndMaybeKickoff,
  persistImplicitQueuedUserMessage,
  type ChatRunDeps,
} from './chat-ws-loop.js';
import { hasBusySessionRun } from './chat-ws-running-turn.js';
import { SESSIONS_DIR } from './chat-ws-runtime.js';
import { buildSessionImageApiUrl, resolveSessionImageFile } from './images-cache.js';
import type { ScheduledTaskAttachments } from './scheduled-task-attachments.js';
import { scheduledTaskSessionTitle } from './scheduled-task-session-index.js';

const headlessWs = {
  readyState: WebSocket.CLOSED,
  send() {},
} as unknown as WebSocket;

export interface ScheduledTaskExecutorDeps {
  chatDeps: ChatRunDeps;
  listSkillFilenames?: () => Promise<Set<string>>;
  enqueue?: typeof enqueueAndMaybeKickoff;
  persistUserMessage?: typeof persistImplicitQueuedUserMessage;
  /** 执行前确保专属会话可用（缺失则重建、过大则轮换），返回（可能已换绑的）任务。 */
  prepareSession?: (task: ScheduledTask) => Promise<ScheduledTask>;
  clearStaleQueued?: (task: ScheduledTask) => Promise<void>;
  /** 把任务图片放进专属会话 imagesCache，返回随消息发送的会话图片 URL。 */
  stageImages?: (task: ScheduledTask) => Promise<string[]>;
}

/** 专属会话的消息文件（UI + 结构化历史）超过该大小时，下次执行前换新会话。 */
export const SCHEDULED_TASK_SESSION_MAX_BYTES = 20 * 1024 * 1024;

export interface ScheduledTaskSessionDeps {
  store: Pick<ScheduledTaskStore, 'rebindSession'>;
  createSession: (title: string) => Promise<{ id: string }>;
  /** 给新专属会话打任务标记（侧栏「任务会话」分组）。 */
  markSession: (sessionId: string, taskId: string) => Promise<void>;
  sessionExists?: (sessionId: string) => Promise<boolean>;
  sessionBytes?: (sessionId: string) => Promise<number>;
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

/** 新建专属会话并换绑，不影响调度时间。新会话不继承旧会话的对话历史。 */
async function moveTaskToNewSession(task: ScheduledTask, deps: ScheduledTaskSessionDeps): Promise<ScheduledTask> {
  const session = await deps.createSession(scheduledTaskSessionTitle(task.name));
  const rebound = await deps.store.rebindSession(task.id, session.id);
  try {
    await deps.markSession(session.id, task.id);
  } catch (err) {
    console.warn(`[scheduled-tasks] 任务「${task.name}」的新会话打标失败（下次启动回填）:`, err);
  }
  return rebound;
}

/** 会话过大时换新专属会话；旧会话原样保留（由用户自行处理）。 */
export async function rotateScheduledTaskSessionIfOversized(
  task: ScheduledTask,
  deps: ScheduledTaskSessionDeps,
): Promise<ScheduledTask> {
  const sessionBytes = deps.sessionBytes ?? defaultSessionBytes;
  const maxBytes = deps.maxBytes ?? SCHEDULED_TASK_SESSION_MAX_BYTES;
  if ((await sessionBytes(task.sessionId)) < maxBytes) return task;
  return moveTaskToNewSession(task, deps);
}

/** 还没有专属会话（新任务）或已被用户删除时新建并换绑。 */
export async function recreateScheduledTaskSessionIfMissing(
  task: ScheduledTask,
  deps: ScheduledTaskSessionDeps,
): Promise<ScheduledTask> {
  const sessionExists = deps.sessionExists ?? scheduledTaskSessionExists;
  if (task.sessionId && await sessionExists(task.sessionId)) return task;
  return moveTaskToNewSession(task, deps);
}

/** 执行前调用：还没有或已不存在专属会话时新建，否则按需轮换。 */
export async function ensureScheduledTaskSession(
  task: ScheduledTask,
  deps: ScheduledTaskSessionDeps,
): Promise<ScheduledTask> {
  const ready = await recreateScheduledTaskSessionIfMissing(task, deps);
  if (ready !== task) return ready;
  return rotateScheduledTaskSessionIfOversized(task, deps);
}

/**
 * 按图片 id 固定文件名放进会话 imagesCache：同一会话重复执行只复制一次，
 * 会话被删除或轮换后下次执行再复制进新会话。源文件缺失的图片跳过。
 */
export async function stageScheduledTaskImages(task: ScheduledTask): Promise<string[]> {
  if (task.images.length === 0) return [];
  const dir = getImagesCacheSessionDir(task.sessionId);
  await fs.mkdir(dir, { recursive: true });
  const urls: string[] = [];
  for (const image of task.images) {
    const dest = path.join(dir, `sched-${image.id}${path.extname(image.path).toLowerCase() || '.png'}`);
    try {
      await fs.copyFile(image.path, dest, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        console.warn(`[scheduled-tasks] 任务「${task.name}」的图片无法读取，本次不发送:`, image.path);
        continue;
      }
    }
    urls.push(buildSessionImageApiUrl(task.sessionId, dest));
  }
  return urls;
}

const SESSION_IMAGE_URL_RE = /^\/api\/sessions\/([^/]+)\/images\/([^/?#]+)$/;

/** 启动时把旧版本存在会话 imagesCache 里的任务图片转存为任务附件；源图已不在的丢弃。 */
export async function migrateLegacyScheduledTaskImages(
  store: Pick<ScheduledTaskStore, 'list' | 'update'>,
  attachments: Pick<ScheduledTaskAttachments, 'importFile'>,
): Promise<void> {
  for (const task of await store.list()) {
    if (!task.legacyImageUrls?.length) continue;
    const migrated: ScheduledTaskFile[] = [];
    for (const url of task.legacyImageUrls) {
      const match = SESSION_IMAGE_URL_RE.exec(url);
      const fileName = match ? decodeURIComponent(match[2]!) : '';
      const src = match ? resolveSessionImageFile(decodeURIComponent(match[1]!), fileName) : undefined;
      try {
        if (!src) throw new Error('无法识别的图片地址');
        migrated.push(await attachments.importFile(task.id, src, fileName));
      } catch {
        console.warn(`[scheduled-tasks] 任务「${task.name}」的旧图片已不存在，已丢弃:`, url);
      }
    }
    await store.update(task.id, { images: task.images.concat(migrated) });
  }
}

async function defaultListSkillFilenames(): Promise<Set<string>> {
  const skills = await getSkillRegistry().listSkills();
  return new Set(skills.map((s) => s.filename));
}

export async function scheduledTaskSessionExists(sessionId: string): Promise<boolean> {
  if (!sessionId) return false;
  try {
    await fs.access(path.join(SESSIONS_DIR, `${sessionId}.json`));
    return true;
  } catch {
    return false;
  }
}

/**
 * 专属会话正在运行（本任务或用户的对话）。会话空闲时队列里不会有正常等待的项，
 * 残留的本任务项（进程在入队后、出队前退出等）不算忙碌，投递前由 clearStaleScheduledQueueItems 清掉。
 */
export async function isScheduledTaskBusy(task: ScheduledTask): Promise<boolean> {
  return hasBusySessionRun(task.sessionId);
}

/** 会话空闲时删除本任务残留的队列项，避免新投递先跑旧内容、再重复跑一次。 */
export async function clearStaleScheduledQueueItems(task: ScheduledTask): Promise<void> {
  if (hasBusySessionRun(task.sessionId)) return;
  const queue = getTaskQueueManager(SESSIONS_DIR);
  for (const item of await queue.list(task.sessionId)) {
    if (item.scheduledTaskId === task.id) await queue.removeById(task.sessionId, item.id);
  }
}

/** imageUrls：已放进专属会话 imagesCache 的图片 URL（见 stageScheduledTaskImages）。 */
export function buildScheduledTaskInput(
  task: ScheduledTask,
  knownSkills: Set<string>,
  imageUrls: string[] = [],
): TaskEnqueueInput {
  const skills = task.skillFilenames.filter((f) => knownSkills.has(f));
  const filePaths = (task.files ?? []).map((f) => f.path);
  const text = [...skills.map((f) => `#${f}`), ...filePaths, task.prompt].join('\n');
  return {
    text,
    source: 'implicit',
    messageId: randomUUID(),
    ...(skills.length > 0 ? { skills } : {}),
    ...(filePaths.length > 0 ? { referencePaths: filePaths } : {}),
    ...(imageUrls.length > 0 ? { images: imageUrls.slice() } : {}),
    scheduledTaskId: task.id,
  };
}

export function createScheduledTaskExecutor(deps: ScheduledTaskExecutorDeps) {
  const listSkillFilenames = deps.listSkillFilenames ?? defaultListSkillFilenames;
  const enqueue = deps.enqueue ?? enqueueAndMaybeKickoff;
  const persistUserMessage = deps.persistUserMessage ?? persistImplicitQueuedUserMessage;
  const clearStaleQueued = deps.clearStaleQueued ?? clearStaleScheduledQueueItems;
  const stageImages = deps.stageImages ?? stageScheduledTaskImages;

  return async function executeScheduledTask(scheduled: ScheduledTask): Promise<void> {
    const task = deps.prepareSession ? await deps.prepareSession(scheduled) : scheduled;
    await clearStaleQueued(task);
    const input = buildScheduledTaskInput(task, await listSkillFilenames(), await stageImages(task));
    const ws = pickSessionWs(task.sessionId) ?? headlessWs;
    await persistUserMessage(task.sessionId, ws, input);
    await enqueue(deps.chatDeps, task.sessionId, ws, input);
  };
}
