import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';

export type ScheduledTaskIntervalUnit = 'second' | 'minute' | 'hour' | 'day';

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  skillFilenames: string[];
  intervalValue: number;
  intervalUnit: ScheduledTaskIntervalUnit;
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
  name: string;
  prompt: string;
  skillFilenames: string[];
  intervalValue: number;
  intervalUnit: ScheduledTaskIntervalUnit;
  sessionId: string;
  enabled: boolean;
};

export type ScheduledTaskUpdatePatch = Partial<
  Pick<
    ScheduledTask,
    | 'name'
    | 'prompt'
    | 'skillFilenames'
    | 'intervalValue'
    | 'intervalUnit'
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

function assertIntervalValue(intervalValue: number): void {
  if (!Number.isInteger(intervalValue) || intervalValue <= 0) {
    throw new Error('任务间隔必须是正整数');
  }
}

function assertIntervalUnit(unit: ScheduledTaskIntervalUnit): void {
  if (!INTERVAL_UNITS.includes(unit)) {
    throw new Error('任务间隔单位无效');
  }
}

function validateCreateInput(input: ScheduledTaskCreateInput): {
  name: string;
  prompt: string;
  skillFilenames: string[];
  intervalValue: number;
  intervalUnit: ScheduledTaskIntervalUnit;
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
    intervalValue: input.intervalValue,
    intervalUnit: input.intervalUnit,
    sessionId,
    enabled: input.enabled,
  };
}

export class ScheduledTaskStore {
  private tasks: ScheduledTask[] | null = null;
  private opTail: Promise<void> = Promise.resolve();

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

  private async readFromDisk(): Promise<ScheduledTask[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedScheduledTasks;
      if (parsed?.version !== 1 || !Array.isArray(parsed.tasks)) return [];
      return parsed.tasks;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      return [];
    }
  }

  private async persist(tasks: ScheduledTask[]): Promise<void> {
    const payload: PersistedScheduledTasks = { version: 1, tasks };
    await writeFileAtomic(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
    this.tasks = tasks;
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
      const task: ScheduledTask = {
        id: randomUUID(),
        ...normalized,
        createdAt: ts,
        updatedAt: ts,
        lastRunAt: null,
        nextRunAt: normalized.enabled ? ts + intervalMs : null,
        lastStatus: 'idle',
        lastError: null,
      };
      tasks.push(task);
      await this.persist(tasks);
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
        intervalValue,
        intervalUnit,
        enabled,
        nextRunAt,
        updatedAt: ts,
      };
      tasks[index] = updated;
      await this.persist(tasks);
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
      tasks[index] = updated;
      await this.persist(tasks);
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
        updatedAt: this.now(),
      };
      tasks[index] = updated;
      await this.persist(tasks);
      return cloneTask(updated);
    });
  }
}
