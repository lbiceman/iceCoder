import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';

export type ScheduledTaskIntervalUnit = 'second' | 'minute' | 'hour' | 'day';

/**
 * interval：按固定间隔；daily：每天 timeOfDay；weekly：weekdays 中每一天的 timeOfDay；
 * monthly：每月 monthDays 中每一天的 timeOfDay。钟点按服务所在机器的本地时区。
 */
export type ScheduledTaskScheduleKind = 'interval' | 'daily' | 'weekly' | 'monthly';

export interface ScheduledTaskSchedule {
  scheduleKind: ScheduledTaskScheduleKind;
  /** 钟点任务不使用间隔，但仍保留一组合法值，切回 interval 时沿用。 */
  intervalValue: number;
  intervalUnit: ScheduledTaskIntervalUnit;
  /** 'HH:mm'（24 小时制）；interval 任务为空串。 */
  timeOfDay: string;
  /** 0=周日 … 6=周六，升序去重；只有 weekly 任务非空。 */
  weekdays: number[];
  /** 1-31，升序去重；只有 monthly 任务非空。当月没有的日期（如 2 月的 30、31 日）在当月最后一天执行。 */
  monthDays: number[];
}

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
  scheduleKind: ScheduledTaskScheduleKind;
  intervalValue: number;
  intervalUnit: ScheduledTaskIntervalUnit;
  timeOfDay: string;
  weekdays: number[];
  monthDays: number[];
  /** 一次性任务：到点执行一次后自动停用。interval 时间隔作为启用后的等待时长，钟点任务在下一个匹配时刻执行。 */
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
  /** 缺省为 interval。 */
  scheduleKind?: ScheduledTaskScheduleKind;
  /** interval 必填；钟点任务可省略。 */
  intervalValue?: number;
  intervalUnit?: ScheduledTaskIntervalUnit;
  timeOfDay?: string;
  weekdays?: number[];
  monthDays?: number[];
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
    | 'scheduleKind'
    | 'intervalValue'
    | 'intervalUnit'
    | 'timeOfDay'
    | 'weekdays'
    | 'monthDays'
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

/** 严格晚于 after 的下一个匹配钟点（本地时区）。 */
export function nextClockRunAt(schedule: ScheduledTaskSchedule, after: number): number {
  const [hour, minute] = schedule.timeOfDay.split(':').map(Number) as [number, number];
  const day = new Date(after);
  // 今天 + 之后 7 天必然覆盖任意星期组合；超出月长的日期落到月末，所以任意两个相邻匹配日相隔不超过 31 天。
  const span = schedule.scheduleKind === 'monthly' ? 32 : 8;
  for (let i = 0; i < span; i++) {
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate() + i, hour, minute, 0, 0);
    if (candidate.getTime() <= after) continue;
    if (schedule.scheduleKind === 'weekly' && !schedule.weekdays.includes(candidate.getDay())) continue;
    if (schedule.scheduleKind === 'monthly' && !matchesMonthDay(schedule.monthDays, candidate)) continue;
    return candidate.getTime();
  }
  throw new Error('无法计算下次执行时间');
}

function matchesMonthDay(monthDays: number[], date: Date): boolean {
  const day = date.getDate();
  if (monthDays.includes(day)) return true;
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return day === lastDay && monthDays.some((d) => d > lastDay);
}

export function isClockScheduleKind(kind: ScheduledTaskScheduleKind): boolean {
  return kind === 'daily' || kind === 'weekly' || kind === 'monthly';
}

function isClockSchedule(schedule: ScheduledTaskSchedule): boolean {
  return isClockScheduleKind(schedule.scheduleKind);
}

/** 新建、修改调度或重新启用时的首次执行时间。 */
export function firstRunAt(schedule: ScheduledTaskSchedule, now: number): number {
  return isClockSchedule(schedule)
    ? nextClockRunAt(schedule, now)
    : now + intervalToMs(schedule.intervalValue, schedule.intervalUnit);
}

/** 到点后的下一次：间隔任务按原节拍推进（不漂移），钟点任务取 now 之后最近的匹配时刻。 */
export function advanceSchedule(schedule: ScheduledTaskSchedule, nextRunAt: number, now: number): number {
  return isClockSchedule(schedule)
    ? nextClockRunAt(schedule, Math.max(nextRunAt, now))
    : advanceToFuture(nextRunAt, intervalToMs(schedule.intervalValue, schedule.intervalUnit), now);
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

export const SCHEDULE_KIND_INVALID_MESSAGE = '调度方式无效';
export const TIME_OF_DAY_INVALID_MESSAGE = '执行时刻格式应为 HH:mm';
export const WEEKDAYS_EMPTY_MESSAGE = '每周执行至少选择一天';
export const WEEKDAYS_INVALID_MESSAGE = '星期取值应为 0-6 的整数（0 为周日）';
export const MONTH_DAYS_EMPTY_MESSAGE = '每月执行至少选择一天';
export const MONTH_DAYS_INVALID_MESSAGE = '日期取值应为 1-31 的整数';

/** 接受 H:mm / HH:mm；「24 点」按次日零点记为 00:00。 */
export function normalizeTimeOfDay(raw: unknown): string {
  const m = typeof raw === 'string' ? /^\s*(\d{1,2}):(\d{2})\s*$/.exec(raw) : null;
  if (!m) throw new Error(TIME_OF_DAY_INVALID_MESSAGE);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour === 24 && minute === 0) return '00:00';
  if (hour > 23 || minute > 59) throw new Error(TIME_OF_DAY_INVALID_MESSAGE);
  return `${String(hour).padStart(2, '0')}:${m[2]}`;
}

function normalizeWeekdays(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(WEEKDAYS_EMPTY_MESSAGE);
  if (!raw.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new Error(WEEKDAYS_INVALID_MESSAGE);
  return [...new Set(raw as number[])].sort((a, b) => a - b);
}

function normalizeMonthDays(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(MONTH_DAYS_EMPTY_MESSAGE);
  if (!raw.every((d) => Number.isInteger(d) && d >= 1 && d <= 31)) throw new Error(MONTH_DAYS_INVALID_MESSAGE);
  return [...new Set(raw as number[])].sort((a, b) => a - b);
}

/** 校验并规整调度字段：只校验当前方式用到的字段，用不到的清空（间隔字段对钟点任务缺省为 1 天）。 */
export function normalizeSchedule(raw: Partial<ScheduledTaskSchedule>): ScheduledTaskSchedule {
  const scheduleKind = raw.scheduleKind ?? 'interval';
  if (scheduleKind === 'interval') {
    assertIntervalValue(raw.intervalValue as number);
    assertIntervalUnit(raw.intervalUnit as ScheduledTaskIntervalUnit);
    return {
      scheduleKind,
      intervalValue: raw.intervalValue as number,
      intervalUnit: raw.intervalUnit as ScheduledTaskIntervalUnit,
      timeOfDay: '',
      weekdays: [],
      monthDays: [],
    };
  }
  if (!isClockScheduleKind(scheduleKind)) throw new Error(SCHEDULE_KIND_INVALID_MESSAGE);
  const intervalValid = Number.isInteger(raw.intervalValue) && (raw.intervalValue as number) > 0
    && INTERVAL_UNITS.includes(raw.intervalUnit as ScheduledTaskIntervalUnit);
  return {
    scheduleKind,
    intervalValue: intervalValid ? raw.intervalValue as number : 1,
    intervalUnit: intervalValid ? raw.intervalUnit as ScheduledTaskIntervalUnit : 'day',
    timeOfDay: normalizeTimeOfDay(raw.timeOfDay),
    weekdays: scheduleKind === 'weekly' ? normalizeWeekdays(raw.weekdays) : [],
    monthDays: scheduleKind === 'monthly' ? normalizeMonthDays(raw.monthDays) : [],
  };
}

function sameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.scheduleKind !== b.scheduleKind) return false;
  if (a.scheduleKind === 'interval') return a.intervalValue === b.intervalValue && a.intervalUnit === b.intervalUnit;
  return a.timeOfDay === b.timeOfDay
    && a.weekdays.join(',') === b.weekdays.join(',')
    && a.monthDays.join(',') === b.monthDays.join(',');
}

/** 旧版本持久化的任务没有附件字段、once 与钟点调度字段，图片存的是会话图片 URL 字符串。 */
function normalizeLoadedTask(task: ScheduledTask): ScheduledTask {
  const rawImages: unknown[] = Array.isArray(task.images) ? task.images : [];
  const legacyImageUrls = (task.legacyImageUrls ?? []).concat(
    rawImages.filter((img): img is string => typeof img === 'string'),
  );
  const normalized: ScheduledTask = {
    ...task,
    images: rawImages.filter((img): img is ScheduledTaskFile => typeof img === 'object' && img !== null),
    files: Array.isArray(task.files) ? task.files : [],
    scheduleKind: task.scheduleKind ?? 'interval',
    timeOfDay: typeof task.timeOfDay === 'string' ? task.timeOfDay : '',
    weekdays: Array.isArray(task.weekdays) ? task.weekdays : [],
    monthDays: Array.isArray(task.monthDays) ? task.monthDays : [],
    once: task.once === true,
  };
  if (legacyImageUrls.length > 0) normalized.legacyImageUrls = legacyImageUrls;
  else delete normalized.legacyImageUrls;
  return normalized;
}

function validateCreateInput(input: ScheduledTaskCreateInput): ScheduledTaskSchedule & {
  name: string;
  prompt: string;
  skillFilenames: string[];
  images: ScheduledTaskFile[];
  files: ScheduledTaskFile[];
  once: boolean;
  sessionId: string;
  enabled: boolean;
} {
  const name = input.name.trim();
  if (!name) throw new Error('任务名称不能为空');
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('任务提示词不能为空');
  const schedule = normalizeSchedule(input);
  const sessionId = input.sessionId.trim();
  return {
    name,
    prompt,
    skillFilenames: normalizeSkillFilenames(input.skillFilenames),
    images: input.images ?? [],
    files: input.files ?? [],
    ...schedule,
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
      const id = input.id?.trim() || randomUUID();
      if (tasks.some((t) => t.id === id)) throw new Error(`定时任务 id 已存在: ${id}`);
      const task: ScheduledTask = {
        id,
        ...normalized,
        createdAt: ts,
        updatedAt: ts,
        lastRunAt: null,
        nextRunAt: normalized.enabled ? firstRunAt(normalized, ts) : null,
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
      const schedule = normalizeSchedule({
        scheduleKind: patch.scheduleKind ?? current.scheduleKind,
        intervalValue: patch.intervalValue ?? current.intervalValue,
        intervalUnit: patch.intervalUnit ?? current.intervalUnit,
        timeOfDay: patch.timeOfDay ?? current.timeOfDay,
        weekdays: patch.weekdays ?? current.weekdays,
        monthDays: patch.monthDays ?? current.monthDays,
      });
      if (patch.enabled !== undefined) {
        enabled = patch.enabled;
      }

      const scheduleChanged = !sameSchedule(schedule, current);
      const reenabled = !current.enabled && enabled;

      let nextRunAt = current.nextRunAt;
      if (!enabled) {
        nextRunAt = null;
      } else if (scheduleChanged || reenabled) {
        nextRunAt = firstRunAt(schedule, ts);
      }

      const updated: ScheduledTask = {
        ...current,
        name,
        prompt,
        skillFilenames,
        images,
        files,
        ...schedule,
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
