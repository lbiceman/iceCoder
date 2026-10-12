/**
 * 定时任务增删改：REST 路由与聊天工具 scheduled_task 共用，保证两边校验、附件清理、重新调度一致。
 *
 * 新建任务不建会话：sessionId 留空，首次执行时才创建专属会话（见 scheduled-task-runtime）。
 * 新附件按任务 id 归档。
 *
 * input 与 REST 请求体同形：images/files 为附件引用（见 scheduled-task-attachments），不传则不改附件。
 */

import { randomUUID } from 'node:crypto';
import {
  normalizeSchedule,
  type ScheduledTask,
  type ScheduledTaskFile,
  type ScheduledTaskIntervalUnit,
  type ScheduledTaskScheduleKind,
  type ScheduledTaskStore,
  type ScheduledTaskUpdatePatch,
} from '../session/scheduled-task-store.js';
import type { ScheduledTaskScheduler } from '../session/scheduled-task-scheduler.js';
import type { ScheduledTaskAttachments } from './scheduled-task-attachments.js';

export const SCHEDULED_TASK_NOT_FOUND_PREFIX = '定时任务不存在';

export interface ScheduledTaskServiceDeps {
  store: ScheduledTaskStore;
  scheduler: Pick<ScheduledTaskScheduler, 'reschedule' | 'runNow'>;
  attachments: ScheduledTaskAttachments;
}

export type ScheduledTaskInput = Record<string, unknown>;

export interface ScheduledTaskService {
  list(): Promise<ScheduledTask[]>;
  get(id: string): Promise<ScheduledTask>;
  create(input: ScheduledTaskInput): Promise<ScheduledTask>;
  update(id: string, input: ScheduledTaskInput): Promise<ScheduledTask>;
  /** enabled 省略时取反。 */
  toggle(id: string, enabled?: boolean): Promise<ScheduledTask>;
  remove(id: string): Promise<void>;
  runNow(id: string): Promise<ScheduledTask | undefined>;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asSkillList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

/** 非数组原样交给 normalizeSchedule 报错；元素按数字解析（REST 表单可能传字符串）。 */
function asWeekdays(v: unknown): number[] {
  return Array.isArray(v) ? v.map((d) => (typeof d === 'string' && d.trim() !== '' ? Number(d) : d) as number) : (v as number[]);
}

function parsePatch(input: ScheduledTaskInput): ScheduledTaskUpdatePatch {
  const patch: ScheduledTaskUpdatePatch = {};
  if (input.name !== undefined) patch.name = asString(input.name);
  if (input.prompt !== undefined) patch.prompt = asString(input.prompt);
  if (input.skillFilenames !== undefined) patch.skillFilenames = asSkillList(input.skillFilenames);
  if (input.scheduleKind !== undefined) patch.scheduleKind = input.scheduleKind as ScheduledTaskScheduleKind;
  if (input.intervalValue !== undefined) patch.intervalValue = Number(input.intervalValue);
  if (input.intervalUnit !== undefined) patch.intervalUnit = input.intervalUnit as ScheduledTaskIntervalUnit;
  if (input.timeOfDay !== undefined) patch.timeOfDay = input.timeOfDay as string;
  if (input.weekdays !== undefined) patch.weekdays = asWeekdays(input.weekdays);
  if (input.once !== undefined) patch.once = input.once === true;
  if (input.enabled !== undefined) patch.enabled = input.enabled === true;
  return patch;
}

function newFilesOf(next: ScheduledTaskFile[] | undefined, current: ScheduledTaskFile[]): ScheduledTaskFile[] {
  return (next ?? []).filter((f) => !current.some((c) => c.id === f.id));
}

function droppedFilesOf(current: ScheduledTaskFile[], next: ScheduledTaskFile[]): ScheduledTaskFile[] {
  return current.filter((f) => !next.some((n) => n.id === f.id));
}

export function createScheduledTaskService(deps: ScheduledTaskServiceDeps): ScheduledTaskService {
  const { store, scheduler, attachments } = deps;

  async function get(id: string): Promise<ScheduledTask> {
    const task = await store.get(id);
    if (!task) throw new Error(`${SCHEDULED_TASK_NOT_FOUND_PREFIX}: ${id}`);
    return task;
  }

  return {
    list: () => store.list(),

    get,

    async create(input) {
      const name = asString(input.name).trim();
      const prompt = asString(input.prompt).trim();
      if (!name) throw new Error('任务名称不能为空');
      if (!prompt) throw new Error('任务提示词不能为空');
      // 先做完整校验再复制附件，避免非法输入留下孤儿附件。
      const { scheduleKind, intervalValue, intervalUnit, timeOfDay, weekdays } = parsePatch(input);
      const draft = {
        name,
        prompt,
        skillFilenames: asSkillList(input.skillFilenames),
        ...normalizeSchedule({ scheduleKind, intervalValue, intervalUnit, timeOfDay, weekdays }),
        once: input.once === true,
        enabled: input.enabled !== false,
      };
      attachments.precheck(input);
      const id = randomUUID();
      const attached = await attachments.resolve(id, input);
      let task;
      try {
        task = await store.create({ ...draft, ...attached, id, sessionId: '' });
      } catch (err) {
        await attachments.removeFiles([...(attached.images ?? []), ...(attached.files ?? [])]);
        throw err;
      }
      await scheduler.reschedule();
      return task;
    },

    async update(id, input) {
      const current = await get(id);
      const attached = await attachments.resolve(current.id, input, current);
      let task;
      try {
        task = await store.update(id, { ...parsePatch(input), ...attached });
      } catch (err) {
        await attachments.removeFiles([
          ...newFilesOf(attached.images, current.images),
          ...newFilesOf(attached.files, current.files),
        ]);
        throw err;
      }
      await attachments.removeFiles([
        ...droppedFilesOf(current.images, task.images),
        ...droppedFilesOf(current.files, task.files),
      ]);
      await scheduler.reschedule();
      return task;
    },

    async toggle(id, enabled) {
      const current = await get(id);
      const task = await store.update(id, { enabled: enabled ?? !current.enabled });
      await scheduler.reschedule();
      return task;
    },

    async remove(id) {
      const current = await store.get(id);
      await store.remove(id);
      if (current) await attachments.removeFiles([...current.images, ...current.files]);
      await scheduler.reschedule();
    },

    async runNow(id) {
      await scheduler.runNow(id);
      return store.get(id);
    },
  };
}
