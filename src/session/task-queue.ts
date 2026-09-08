import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseReasoningEffort, type ReasoningEffort } from '../llm/reasoning-effort.js';

export interface QueuedTask {
  id: string;
  text: string;
  messageId?: string;
  images?: string[];
  skills?: string[];
  referencePaths?: string[];
  /** 该任务整轮 LLM 调用使用的推理强度（发送时捕获） */
  reasoningEffort?: ReasoningEffort;
  enqueuedAt: number;
  source: 'implicit' | 'explicit';
}

export type TaskEnqueueInput = Omit<QueuedTask, 'id' | 'enqueuedAt'> & { text: string };

function taskQueueFilePath(sessionsDir: string, sessionId: string): string {
  return path.join(sessionsDir, `${sessionId}.task-queue.json`);
}

function toQueuedTask(task: TaskEnqueueInput, id: string, enqueuedAt: number): QueuedTask {
  const reasoningEffort = parseReasoningEffort(task.reasoningEffort);
  return {
    id,
    text: task.text,
    messageId: task.messageId,
    images: task.images,
    referencePaths: task.referencePaths,
    skills: task.skills,
    enqueuedAt,
    source: task.source,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function withParsedReasoningEffort(item: QueuedTask): QueuedTask {
  const reasoningEffort = parseReasoningEffort(item.reasoningEffort);
  if (reasoningEffort) return { ...item, reasoningEffort };
  if (!item.reasoningEffort) return item;
  const { reasoningEffort: _drop, ...rest } = item;
  return rest;
}

export class TaskQueueManager {
  private readonly queues = new Map<string, QueuedTask[]>();

  constructor(readonly sessionsDir: string) {}

  private async ensureLoaded(sessionId: string): Promise<QueuedTask[]> {
    let queue = this.queues.get(sessionId);
    if (queue) return queue;
    queue = await this.readFromDisk(sessionId);
    this.queues.set(sessionId, queue);
    return queue;
  }

  private async readFromDisk(sessionId: string): Promise<QueuedTask[]> {
    try {
      const raw = await fs.readFile(taskQueueFilePath(this.sessionsDir, sessionId), 'utf-8');
      const parsed = JSON.parse(raw) as QueuedTask[];
      if (!Array.isArray(parsed)) return [];
      return parsed.map(withParsedReasoningEffort);
    } catch {
      return [];
    }
  }

  private async persist(sessionId: string, queue: QueuedTask[]): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const file = taskQueueFilePath(this.sessionsDir, sessionId);
    if (queue.length === 0) {
      await fs.unlink(file).catch(() => {});
      return;
    }
    await fs.writeFile(file, JSON.stringify(queue, null, 2), 'utf-8');
  }

  async load(sessionId: string): Promise<void> {
    await this.ensureLoaded(sessionId);
  }

  async list(sessionId: string): Promise<QueuedTask[]> {
    const queue = await this.ensureLoaded(sessionId);
    return queue.map((item) => ({ ...item }));
  }

  async enqueue(sessionId: string, task: TaskEnqueueInput): Promise<QueuedTask> {
    const queue = await this.ensureLoaded(sessionId);
    const entry = toQueuedTask(task, randomUUID(), Date.now());
    queue.push(entry);
    await this.persist(sessionId, queue);
    return { ...entry };
  }

  async dequeue(sessionId: string): Promise<QueuedTask | undefined> {
    const queue = await this.ensureLoaded(sessionId);
    const next = queue.shift();
    await this.persist(sessionId, queue);
    return next ? { ...next } : undefined;
  }

  async removeById(sessionId: string, id: string): Promise<QueuedTask | undefined> {
    const queue = await this.ensureLoaded(sessionId);
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const [removed] = queue.splice(index, 1);
    await this.persist(sessionId, queue);
    return { ...removed };
  }

  async insertAt(
    sessionId: string,
    index: number,
    task: TaskEnqueueInput,
  ): Promise<QueuedTask> {
    const queue = await this.ensureLoaded(sessionId);
    const clamped = Math.max(0, Math.min(index, queue.length));
    const entry = toQueuedTask(task, randomUUID(), Date.now());
    queue.splice(clamped, 0, entry);
    await this.persist(sessionId, queue);
    return { ...entry };
  }

  async clearSession(sessionId: string): Promise<void> {
    this.queues.delete(sessionId);
    await fs.unlink(taskQueueFilePath(this.sessionsDir, sessionId)).catch(() => {});
  }
}

let sharedTaskQueueManager: TaskQueueManager | null = null;

export function getTaskQueueManager(sessionsDir?: string): TaskQueueManager {
  const dir = sessionsDir ?? path.resolve(process.env.ICE_SESSIONS_DIR!);
  if (!sharedTaskQueueManager || sharedTaskQueueManager.sessionsDir !== dir) {
    sharedTaskQueueManager = new TaskQueueManager(dir);
  }
  return sharedTaskQueueManager;
}

export function resetTaskQueueManagerForTests(): void {
  sharedTaskQueueManager = null;
}
