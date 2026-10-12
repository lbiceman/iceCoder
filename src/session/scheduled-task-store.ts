import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';

export type ScheduledTaskIntervalUnit = 'second' | 'minute' | 'hour' | 'day';

/** 任务附带的图片或文件（已转存到任务附件目录的长期副本，不随会话删除）。 */
export interface ScheduledTaskFile {
  id: string;
  name: string;
  path: string;
  size: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  skillFilenames: string[];
  /** 执行时复制进当时专属会话的 imagesCache，随消息发送。 */
  images: ScheduledTaskFile[];
  /** 旧版本存的会话图片 URL（会随会话删除丢失），启动时迁移进 images；写入新 images 后清除。 */
  legacyImageUrls?: string[];
  files: ScheduledTaskFile[];
  intervalValue: number;
  intervalUnit: ScheduledTaskIntervalUnit;
  /** 一次性任务：到点执行一次后自动停用，间隔作为启用后的等待时长。 */
  once: boolean;
  /** 专属会话；空串表示还没有会话——会话只在执行时创建（见 scheduled-task-runtime）。 */
  sessionId: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastStatus: 'idle' | 'queued' | 'success' | 'error';
  lastError: string | null;
}

export type ScheduledTaskCreateInput = {
  /** 调用方预先生成（附件目录要在建任务前按任务 id 落盘）；缺省时随机生成。 */
  id?: string;
  name: string;
  prompt: string;
  skillFilenames: string[];
  images?: ScheduledTaskFile[];
  files?: ScheduledTaskFile[];
  intervalValue: number;
  intervalUnit: ScheduledTaskIntervalUnit;
  once?: boolean;
  sessionId: string;
  enabled: boolean;
};

export type ScheduledTaskUpdatePatch = Partial<
  Pick<
    ScheduledTask,
    | 'name'
    | 'prompt'
    | 'skillFilenames'
    | 'images'
    | 'files'
    | 'intervalValue'
    | 'intervalUnit'
    | 'once'
    | 'enabled'
  >
>;

export type ScheduledTaskRunStatePatch = Partial<
  Pick<ScheduledTask, 'lastRunAt' | 'lastStatus' | 'lastError'>
>;

const INTERVAL_UNITS: readonly ScheduledTaskIntervalUnit[] = [
  'second',
  'minute',
  'hour',
  'day',
];

interface PersistedScheduledTasks {
  version: 1;
  tasks: ScheduledTask[];
}

export function intervalToMs(value: number, unit: ScheduledTaskIntervalUnit): number {
  switch (unit) {
    case 'second':
      return value * 1_000;
    case 'minute':
      return value * 60_000;
    case 'hour':
      return value * 3_600_000;
    case 'day':
      return value * 86_400_000;
    default:
      throw new Error('任务间隔单位无效');
  }
}

export function advanceToFuture(nextRunAt: number, intervalMs: number, now: number): number {
  if (nextRunAt > now) return nextRunAt;
  return nextRunAt + (Math.floor((now - nextRunAt) / intervalMs) + 1) * intervalMs;
}

function cloneTask(task: ScheduledTask): ScheduledTask {
  return structuredClone(task);
}

function normalizeSkillFilenames(filenames: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of filenames) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function assertIntervalValue(intervalValue: number): void {
  if (!Number.isInteger(intervalValue) || intervalValue <= 0) {
    throw new Error('任务间隔必须是正整数');
  }
}

export function assertIntervalUnit(unit: ScheduledTaskIntervalUnit): void {
  if (!INTERVAL_UNITS.includes(unit)) {
    throw new Error('任务间隔单位无效');
  }
}

/** 旧版本持久化的任务没有附件字段与 once，图片存的是会话图片 URL 字符串。 */
function normalizeLoadedTask(task: ScheduledTask): ScheduledTask {
  const rawImages: unknown[] = Array.isArray(task.images) ? task.images : [];
  const legacyImageUrls = (task.legacyImageUrls ?? []).concat(
    rawImages.filter((img): img is string => typeof img === 'string'),
  );
  const normalized: ScheduledTask = {
    ...task,
    images: rawImages.filter((img): img is ScheduledTaskFile => typeof img === 'object' && img !== null),
    files: Array.isArray(task.files) ? task.files : [],
    once: task.once === true,
  };
  if (legacyImageUrls.length > 0) normalized.legacyImageUrls = legacyImageUrls;
  else delete normalized.legacyImageUrls;
  return normalized;
}

function validateCreateInput(input: ScheduledTaskCreateInput): {
  name: string;
  prompt: string;
  skillFilenames: string[];
  images: ScheduledTaskFile[];
  files: ScheduledTaskFile[];
  intervalValue: number;
  intervalUnit: ScheduledTaskIntervalUnit;
  once: boolean;
  sessionId: string;
  enabled: boolean;
} {
  const name = input.name.trim();
  if (!name) throw new Error('任务名称不能为空');
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('任务提示词不能为空');
  assertIntervalValue(input.intervalValue);
  assertIntervalUnit(input.intervalUnit);
  const sessionId = input.sessionId.trim();
  return {
    name,
    prompt,
    skillFilenames: normalizeSkillFilenames(input.skillFilenames),
    images: input.images ?? [],
    files: input.files ?? [],
    intervalValue: input.intervalValue,
    intervalUnit: input.intervalUnit,
    once: input.once === true,
    sessionId,
    enabled: input.enabled,
  };
}

export class ScheduledTaskStore {
  private tasks: ScheduledTask[] | null = null;
  private opTail: Promise<void> = Promise.resolve();
  private readonly changeListeners: Array<() => void> = [];

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opTail.then(op, op);
    this.opTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureLoaded(): Promise<ScheduledTask[]> {
    if (this.tasks) return this.tasks;
    this.tasks = await this.readFromDisk();
    return this.tasks;
  }

  /** IO 错误直接抛出且不缓存，留给调用方重试；只有内容无法识别时才按空列表继续。 */
  private async readFromDisk(): Promise<ScheduledTask[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: PersistedScheduledTasks | null = null;
    try {
      parsed = JSON.parse(raw) as PersistedScheduledTasks;
    } catch {
      /* 交给下方备份 */
    }
    if (parsed?.version === 1 && Array.isArray(parsed.tasks)) return parsed.tasks.map(normalizeLoadedTask);
    await this.backupUnreadable();
    return [];
  }

  /** 下一次写入会覆盖整个文件，先把认不出的内容另存一份。 */
  private async backupUnreadable(): Promise<void> {
    const backup = `${this.filePath}.broken-${this.now()}`;
    try {
      await fs.copyFile(this.filePath, backup);
      console.warn(`[scheduled-tasks] 任务文件无法识别，已按空列表加载，原文件备份到 ${backup}`);
    } catch (err) {
      console.warn('[scheduled-tasks] 任务文件无法识别且备份失败:', err);
    }
  }

  private async persist(tasks: ScheduledTask[]): Promise<void> {
    const payload: PersistedScheduledTasks = { version: 1, tasks };
    await writeFileAtomic(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
    this.tasks = tasks;
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err) {
        console.warn('[scheduled-tasks] 变更监听器出错:', err);
      }
    }
  }

  /** 每次成功写盘后同步回调（任务增删改、执行状态、下次执行时间）。 */
  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  async list(): Promise<ScheduledTask[]> {
    return this.runExclusive(async () => {
      const tasks = await this.ensureLoaded();
      return tasks.map(cloneTask);
    });
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    return this.runExclusive(async () => {
      const tasks = await this.ensureLoaded();
      const task = tasks.find((t) => t.id === id);
      return task ? cloneTask(task) : undefined;
    });
  }

  async create(input: ScheduledTaskCreateInput): Promise<ScheduledTask> {
    return this.runExclusive(async () => {
      const tasks = await this.ensureLoaded();
      const normalized = validateCreateInput(input);
      const ts = this.now();
      const intervalMs = intervalToMs(normalized.intervalValue, normalized.intervalUnit);
      const id = input.id?.trim() || randomUUID();
      if (tasks.some((t) => t.id === id)) throw new Error(`定时任务 id 已存在: ${id}`);
      const task: ScheduledTask = {
        id,
        ...normalized,
        createdAt: ts,
        updatedAt: ts,
        lastRunAt: null,
        nextRunAt: normalized.enabled ? ts + intervalMs : null,
        lastStatus: 'idle',
        lastError: null,
      };
      const next = tasks.concat(task);
      await this.persist(next);
      return cloneTask(task);
    });
  }

  async update(id: string, patch: ScheduledTaskUpdatePatch): Promise<ScheduledTask> {
    return this.runExclusive(async () => {
      const tasks = await this.ensureLoaded();
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) throw new Error(`定时任务不存在: ${id}`);
      const current = tasks[index]!;
      const ts = this.now();

      let name = current.name;
      let prompt = current.prompt;
      let skillFilenames = current.skillFilenames;
      let intervalValue = current.intervalValue;
      let intervalUnit = current.intervalUnit;
      let enabled = current.enabled;

      if (patch.name !== undefined) {
        name = patch.name.trim();
        if (!name) throw new Error('任务名称不能为空');
      }
      if (patch.prompt !== undefined) {
        prompt = patch.prompt.trim();
        if (!prompt) throw new Error('任务提示词不能为空');
      }
      if (patch.skillFilenames !== undefined) {
        skillFilenames = normalizeSkillFilenames(patch.skillFilenames);
      }
      const images = patch.images ?? current.images;
      const files = patch.files ?? current.files;
      const once = patch.once ?? current.once;
      if (patch.intervalValue !== undefined) {
        assertIntervalValue(patch.intervalValue);
        intervalValue = patch.intervalValue;
      }
      if (patch.intervalUnit !== undefined) {
        assertIntervalUnit(patch.intervalUnit);
        intervalUnit = patch.intervalUnit;
      }
      if (patch.enabled !== undefined) {
        enabled = patch.enabled;
      }

      const intervalChanged =
        intervalValue !== current.intervalValue || intervalUnit !== current.intervalUnit;
      const reenabled = !current.enabled && enabled;

      let nextRunAt = current.nextRunAt;
      if (!enabled) {
        nextRunAt = null;
      } else if (intervalChanged || reenabled) {
        nextRunAt = ts + intervalToMs(intervalValue, intervalUnit);
      }

      const updated: ScheduledTask = {
        ...current,
        name,
        prompt,
        skillFilenames,
        images,
        files,
        intervalValue,
        intervalUnit,
        once,
        enabled,
        nextRunAt,
        updatedAt: ts,
      };
      if (patch.images !== undefined) delete updated.legacyImageUrls;
      const next = tasks.slice();
      next[index] = updated;
      await this.persist(next);
      return cloneTask(updated);
    });
  }

  /** 换绑专属会话（会话轮换或原会话已删除），不影响调度时间。 */
  async rebindSession(id: string, sessionId: string): Promise<ScheduledTask> {
    return this.runExclusive(async () => {
      const tasks = await this.ensureLoaded();
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) throw new Error(`定时任务不存在: ${id}`);
      const updated: ScheduledTask = { ...tasks[index]!, sessionId, updatedAt: this.now() };
      const next = tasks.slice();
      next[index] = updated;
      await this.persist(next);
      return cloneTask(updated);
    });
  }

  async remove(id: string): Promise<void> {
    return this.runExclusive(async () => {
      const tasks = await this.ensureLoaded();
      const next = tasks.filter((t) => t.id !== id);
      if (next.length === tasks.length) throw new Error(`定时任务不存在: ${id}`);
      await this.persist(next);
    });
  }

  async replaceNextRunAt(id: string, nextRunAt: number): Promise<ScheduledTask> {
    return this.runExclusive(async () => {
      const tasks = await this.ensureLoaded();
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) throw new Error(`定时任务不存在: ${id}`);
      const current = tasks[index]!;
      const ts = this.now();
      const updated: ScheduledTask = {
        ...current,
        nextRunAt,
        updatedAt: ts,
      };
      const next = tasks.slice();
      next[index] = updated;
      await this.persist(next);
      return cloneTask(updated);
    });
  }

  async updateRunState(id: string, patch: ScheduledTaskRunStatePatch): Promise<ScheduledTask> {
    return this.runExclusive(async () => {
      const tasks = await this.ensureLoaded();
      const index = tasks.findIndex((t) => t.id === id);
      if (index < 0) throw new Error(`定时任务不存在: ${id}`);
      const current = tasks[index]!;
      const updated: ScheduledTask = {
        ...current,
        ...(patch.lastRunAt !== undefined ? { lastRunAt: patch.lastRunAt } : {}),
        ...(patch.lastStatus !== undefined ? { lastStatus: patch.lastStatus } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
      };
      const next = tasks.slice();
      next[index] = updated;
      await this.persist(next);
      return cloneTask(updated);
    });
  }
}
