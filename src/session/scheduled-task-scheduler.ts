import {
  advanceToFuture,
  intervalToMs,
  type ScheduledTask,
  type ScheduledTaskStore,
} from './scheduled-task-store.js';

/** Node 的 setTimeout 上限约 24.8 天；留出余量。 */
export const MAX_TIMEOUT_MS = 2_147_000_000;

export interface ScheduledTaskSchedulerOptions {
  store: Pick<ScheduledTaskStore, 'list' | 'get' | 'replaceNextRunAt' | 'updateRunState'>;
  /** 将任务投递到执行链路（入队）；抛错表示投递失败。 */
  execute: (task: ScheduledTask) => Promise<void>;
  now?: () => number;
}

export class ScheduledTaskScheduler {
  private readonly store: ScheduledTaskSchedulerOptions['store'];
  private readonly execute: ScheduledTaskSchedulerOptions['execute'];
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: ScheduledTaskSchedulerOptions) {
    this.store = options.store;
    this.execute = options.execute;
    this.now = options.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    this.running = true;
    await this.exclusive(async () => {
      if (!this.running) return;
      const now = this.now();
      const tasks = await this.store.list();
      for (const task of tasks) {
        if (!task.enabled || task.nextRunAt === null || task.nextRunAt > now) continue;
        await this.store.replaceNextRunAt(task.id, this.advance(task, now));
      }
      await this.armNearest();
    });
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  async reschedule(): Promise<void> {
    await this.exclusive(() => this.armNearest());
  }

  async runNow(id: string): Promise<void> {
    const task = await this.store.get(id);
    if (!task) throw new Error(`定时任务不存在: ${id}`);
    await this.trigger(task);
  }

  /** 串行化 start / wake / reschedule；前一步失败不阻断后一步。 */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op, op);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private advance(task: ScheduledTask, now: number): number {
    return advanceToFuture(
      task.nextRunAt!,
      intervalToMs(task.intervalValue, task.intervalUnit),
      now,
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async wake(): Promise<void> {
    if (!this.running) return;
    const now = this.now();
    const tasks = await this.store.list();
    if (!this.running) return;
    const due = tasks.filter(
      (task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now,
    );
    for (const task of due) {
      await this.store.replaceNextRunAt(task.id, this.advance(task, now));
    }
    await Promise.allSettled(due.map((task) => this.trigger(task)));
    await this.armNearest();
  }

  private async armNearest(): Promise<void> {
    this.clearTimer();
    if (!this.running) return;
    const tasks = await this.store.list();
    // stop() 可能发生在 list 期间，此时不能再安排计时器。
    if (!this.running) return;
    const now = this.now();
    let nearest: number | null = null;
    for (const task of tasks) {
      if (!task.enabled || task.nextRunAt === null) continue;
      if (nearest === null || task.nextRunAt < nearest) nearest = task.nextRunAt;
    }
    if (nearest === null) return;
    const delay = Math.min(Math.max(0, nearest - now), MAX_TIMEOUT_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.exclusive(() => this.wake()).catch((err) => {
        console.error('[scheduled-tasks] 调度器唤醒失败:', err);
      });
    }, delay);
  }

  private async trigger(task: ScheduledTask): Promise<void> {
    await this.store.updateRunState(task.id, {
      lastRunAt: this.now(),
      lastStatus: 'queued',
      lastError: null,
    });
    try {
      await this.execute(task);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await this.store.updateRunState(task.id, { lastStatus: 'error', lastError: message });
      } catch {
        // 保留原始投递错误，状态写入失败不覆盖它。
      }
      throw error;
    }
  }
}
