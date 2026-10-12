import {
  advanceToFuture,
  intervalToMs,
  type ScheduledTask,
  type ScheduledTaskStore,
} from './scheduled-task-store.js';

/** Node 的 setTimeout 上限约 24.8 天；留出余量。 */
export const MAX_TIMEOUT_MS = 2_147_000_000;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export interface ScheduledTaskSchedulerOptions {
  store: Pick<ScheduledTaskStore, 'list' | 'get' | 'replaceNextRunAt' | 'updateRunState'>;
  /** 将任务投递到执行链路（入队）；抛错表示投递失败。 */
  execute: (task: ScheduledTask) => Promise<void>;
  /** 上一次执行尚未结束（仍在跑或仍在队列中）时返回 true：定时触发跳过本次，立即执行报错。 */
  isBusy?: (task: ScheduledTask) => boolean | Promise<boolean>;
  now?: () => number;
}

export const SCHEDULED_TASK_BUSY_MESSAGE = '上一次执行尚未结束，请稍后再试';

export class ScheduledTaskScheduler {
  private readonly store: ScheduledTaskSchedulerOptions['store'];
  private readonly execute: ScheduledTaskSchedulerOptions['execute'];
  private readonly isBusy: NonNullable<ScheduledTaskSchedulerOptions['isBusy']>;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** 每次 start / stop 递增；异步工作捕获自己的 generation，过期后不得再产生副作用。 */
  private generation = 0;
  private retryDelayMs = RETRY_BASE_MS;
  /** start 扫描未完成时的快照：重试 wake 对 <= 该时刻的过期任务只推进、不补跑。 */
  private catchUpBefore: number | null = null;
  private tail: Promise<void> = Promise.resolve();
  /** 正在投递中的任务 id：立即执行与定时唤醒不串行，投递完成前外部 isBusy 还看不到队列项。 */
  private readonly delivering = new Set<string>();

  constructor(options: ScheduledTaskSchedulerOptions) {
    this.store = options.store;
    this.execute = options.execute;
    this.isBusy = options.isBusy ?? (() => false);
    this.now = options.now ?? (() => Date.now());
  }

  async start(): Promise<void> {
    const gen = ++this.generation;
    this.running = true;
    this.retryDelayMs = RETRY_BASE_MS;
    await this.exclusive(async () => {
      if (!this.isCurrent(gen)) return;
      try {
        const now = this.now();
        this.catchUpBefore = now;
        const tasks = await this.store.list();
        for (const task of tasks) {
          if (!this.isCurrent(gen)) return;
          if (!task.enabled || task.nextRunAt === null || task.nextRunAt > now) continue;
          await this.store.replaceNextRunAt(task.id, this.advance(task, now));
        }
        await this.armNearest(gen);
        if (this.isCurrent(gen)) this.catchUpBefore = null;
      } catch (err) {
        this.handleScanFailure(gen, err);
      }
    });
  }

  stop(): void {
    this.generation++;
    this.running = false;
    this.clearTimer();
  }

  async reschedule(): Promise<void> {
    const gen = this.generation;
    await this.exclusive(async () => {
      try {
        await this.armNearest(gen);
      } catch (err) {
        this.handleScanFailure(gen, err);
      }
    });
  }

  async runNow(id: string): Promise<void> {
    const task = await this.store.get(id);
    if (!task) throw new Error(`定时任务不存在: ${id}`);
    if (await this.checkBusy(task)) throw new Error(SCHEDULED_TASK_BUSY_MESSAGE);
    await this.trigger(task);
  }

  private async checkBusy(task: ScheduledTask): Promise<boolean> {
    return this.delivering.has(task.id) || (await this.isBusy(task));
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

  private isCurrent(gen: number): boolean {
    return this.running && this.generation === gen;
  }

  private async wake(gen: number): Promise<void> {
    if (!this.isCurrent(gen)) return;
    try {
      const now = this.now();
      const tasks = await this.store.list();
      if (!this.isCurrent(gen)) return;
      const due = tasks.filter(
        (task) => task.enabled && task.nextRunAt !== null && task.nextRunAt <= now,
      );
      // 先逐个持久化下次时间；失败的任务保持到点状态，留给重试，已持久化的照常触发。
      const persisted: ScheduledTask[] = [];
      let failure: unknown;
      let failed = false;
      for (const task of due) {
        if (!this.isCurrent(gen)) return;
        try {
          await this.store.replaceNextRunAt(task.id, this.advance(task, now));
          persisted.push(task);
        } catch (err) {
          if (!failed) failure = err;
          failed = true;
        }
      }
      if (!this.isCurrent(gen)) return;
      // start 扫描未完成时遗留的过期任务只推进、不补跑。
      const skipBefore = this.catchUpBefore;
      const runnable = persisted.filter(
        (task) => skipBefore === null || task.nextRunAt! > skipBefore,
      );
      await Promise.allSettled(runnable.map((task) => this.triggerUnlessBusy(task)));
      // 有持久化失败时不扫描：到点任务会让 delay 变成 0，改走退避重试。
      if (failed) throw failure;
      await this.armNearest(gen);
      if (!this.isCurrent(gen)) return;
      this.catchUpBefore = null;
      this.retryDelayMs = RETRY_BASE_MS;
    } catch (err) {
      this.handleScanFailure(gen, err);
    }
  }

  /** start / reschedule / wake 的 Store 异常统一走这里：记录错误，当前代仍有效则退避重试。 */
  private handleScanFailure(gen: number, err: unknown): void {
    if (!this.isCurrent(gen)) return;
    console.error('[scheduled-tasks] 调度器扫描失败，将退避重试:', err);
    this.scheduleRetry(gen);
  }

  private scheduleRetry(gen: number): void {
    if (!this.isCurrent(gen)) return;
    this.clearTimer();
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
    this.setWakeTimer(gen, delay);
  }

  private setWakeTimer(gen: number, delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.exclusive(() => this.wake(gen)).catch((err) => {
        console.error('[scheduled-tasks] 调度器唤醒失败:', err);
      });
    }, delay);
  }

  private async armNearest(gen: number): Promise<void> {
    if (!this.isCurrent(gen)) return;
    const tasks = await this.store.list();
    // stop() / 新一代 start() 可能发生在 list 期间；过期的一代不得碰计时器。
    if (!this.isCurrent(gen)) return;
    this.clearTimer();
    const now = this.now();
    let nearest: number | null = null;
    for (const task of tasks) {
      if (!task.enabled || task.nextRunAt === null) continue;
      if (nearest === null || task.nextRunAt < nearest) nearest = task.nextRunAt;
    }
    if (nearest === null) return;
    this.setWakeTimer(gen, Math.min(Math.max(0, nearest - now), MAX_TIMEOUT_MS));
  }

  private async triggerUnlessBusy(task: ScheduledTask): Promise<void> {
    if (await this.checkBusy(task)) {
      console.log(`[scheduled-tasks] 「${task.name}」上一次执行尚未结束，跳过本次触发`);
      return;
    }
    await this.trigger(task);
  }

  private async trigger(task: ScheduledTask): Promise<void> {
    this.delivering.add(task.id);
    try {
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
    } finally {
      this.delivering.delete(task.id);
    }
  }
}
