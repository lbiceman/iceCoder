import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScheduledTaskStore } from '../../src/session/scheduled-task-store.js';
import { SCHEDULED_TASK_BUSY_MESSAGE } from '../../src/session/scheduled-task-scheduler.js';
import { createScheduledTaskAttachments } from '../../src/web/scheduled-task-attachments.js';
import { createScheduledTaskService } from '../../src/web/scheduled-task-service.js';
import {
  SCHEDULED_TASK_CREATE_IN_TASK_SESSION_MESSAGE,
  createScheduledTaskTool,
  normalizeIntervalUnit,
  normalizeScheduleKind,
  normalizeWeekdays,
} from '../../src/web/scheduled-task-tool.js';
import type { RegisteredTool } from '../../src/tools/types.js';

describe('scheduled_task tool', () => {
  let dir: string;
  let now: number;
  let store: ScheduledTaskStore;
  const scheduler = { reschedule: vi.fn(async () => {}), runNow: vi.fn(async (_id: string) => {}) };

  function makeTool(inTaskSession = false): RegisteredTool {
    const service = createScheduledTaskService({
      store,
      scheduler,
      attachments: createScheduledTaskAttachments({ filesRoot: path.join(dir, 'task-files'), lookupUpload: () => undefined }),
    });
    return createScheduledTaskTool({
      service,
      inTaskSession,
      listSkillFilenames: async () => new Set(['review.md']),
      formatTime: (ts) => `T${ts}`,
    });
  }

  const createArgs = { action: 'create', name: '巡检', prompt: '检查依赖是否有安全更新', intervalValue: 2, intervalUnit: 'hour' };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-sched-tool-'));
    now = 1_000_000;
    store = new ScheduledTaskStore(path.join(dir, 'tasks.json'), () => now);
    scheduler.reschedule.mockClear();
    scheduler.runNow.mockReset();
    scheduler.runNow.mockImplementation(async () => {});
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('declares action as the only required parameter', () => {
    const def = makeTool().definition;
    expect(def.name).toBe('scheduled_task');
    expect(def.parameters.required).toEqual(['action']);
    for (const [key, schema] of Object.entries(def.parameters.properties as Record<string, { description?: string }>)) {
      if (key !== 'intervalUnit') expect(schema.description, key).toBeTruthy();
    }
  });

  it('describes the full usage so the model need not read source code', () => {
    const description = makeTool().definition.description;
    expect(description).toMatch(/do NOT read iceCoder source code/);
    expect(description).toMatch(/schtasks/);
    expect(description).toMatch(/cron expressions are NOT supported/);
    expect(description).toMatch(/- daily: runs every day at timeOfDay/);
    expect(description).toMatch(/weekdays \[5\], timeOfDay "10:00"/);
    expect(description).not.toMatch(/Clock times .* are NOT supported/);
    expect(description).toMatch(/cannot see this chat/);
    expect(description).toMatch(/auto-approved/);
    expect(description).toMatch(/restarts the countdown/);
    for (const action of ['list', 'create', 'update', 'toggle', 'run', 'delete']) {
      expect(description).toContain(`- ${action}:`);
    }
  });

  it('includes data locations and working directory only when provided', () => {
    const service = createScheduledTaskService({
      store,
      scheduler,
      attachments: createScheduledTaskAttachments({ filesRoot: path.join(dir, 'task-files'), lookupUpload: () => undefined }),
    });
    const bare = createScheduledTaskTool({ service, inTaskSession: false }).definition.description;
    expect(bare).not.toContain('iceCoder data locations');

    const full = createScheduledTaskTool({
      service,
      inTaskSession: false,
      dataPaths: { dataDir: 'D:/ice-data', sessionsDir: 'D:/ice-data/sessions', outputDir: 'D:/ice-data/output' },
      defaultWorkDir: 'D:/work',
    }).definition.description;
    expect(full).toContain('Data dir: D:/ice-data');
    expect(full).toContain('Sessions: D:/ice-data/sessions. index.json');
    expect(full).toContain('none: D:/ice-data/output');
    expect(full).toContain('(currently D:/work)');
  });

  it('creates a task through the app without a session (created on first run) and reschedules', async () => {
    const res = await makeTool().handler(createArgs);
    expect(res.success).toBe(true);
    const [task] = await store.list();
    expect(task).toMatchObject({
      name: '巡检',
      prompt: '检查依赖是否有安全更新',
      intervalValue: 2,
      intervalUnit: 'hour',
      once: false,
      enabled: true,
      sessionId: '',
      nextRunAt: now + 2 * 3_600_000,
    });
    expect(scheduler.reschedule).toHaveBeenCalledTimes(1);
    expect(res.output).toContain('首次执行时会自动创建');
    expect(res.output).toContain(`id=${task!.id}`);
    expect(res.output).toContain('每 2 小时执行一次');
    expect(res.output).toContain(`下次执行：T${now + 2 * 3_600_000}`);
  });

  it('accepts common interval unit spellings and string numbers', async () => {
    const res = await makeTool().handler({ ...createArgs, intervalValue: '30', intervalUnit: 'minutes' });
    expect(res.success).toBe(true);
    expect((await store.list())[0]).toMatchObject({ intervalValue: 30, intervalUnit: 'minute' });
  });

  it.each([
    ['min', 'minute'], ['Hours', 'hour'], ['小时', 'hour'], ['天', 'day'], ['sec', 'second'], ['weekly', 'weekly'],
  ])('normalizeIntervalUnit(%s) = %s', (raw, expected) => {
    expect(normalizeIntervalUnit(raw)).toBe(expected);
  });

  it('creates daily and weekly clock tasks', async () => {
    now = new Date(2026, 9, 12, 16, 36).getTime();
    const tool = makeTool();
    const daily = await tool.handler({ action: 'create', name: '日结', prompt: '汇总当天', scheduleKind: 'daily', timeOfDay: '24:00' });
    expect(daily.success).toBe(true);
    expect(daily.output).toContain('每天 00:00 执行一次');
    expect(daily.output).toContain(`下次执行：T${new Date(2026, 9, 13).getTime()}`);

    const weekly = await tool.handler({ action: 'create', name: '周报', prompt: '写周报', scheduleKind: 'weekly', weekdays: ['周五'], timeOfDay: '10:00' });
    expect(weekly.success).toBe(true);
    expect(weekly.output).toContain('每周五 10:00 执行一次');
    expect((await store.list()).find((t) => t.name === '周报')).toMatchObject({
      scheduleKind: 'weekly', weekdays: [5], timeOfDay: '10:00', nextRunAt: new Date(2026, 9, 16, 10).getTime(),
    });
  });

  it('infers scheduleKind from timeOfDay / weekdays on create', async () => {
    const tool = makeTool();
    await tool.handler({ action: 'create', name: 'a', prompt: 'p', timeOfDay: '08:00' });
    await tool.handler({ action: 'create', name: 'b', prompt: 'p', timeOfDay: '08:00', weekdays: '1,3,5' });
    const tasks = await store.list();
    expect(tasks.find((t) => t.name === 'a')).toMatchObject({ scheduleKind: 'daily' });
    expect(tasks.find((t) => t.name === 'b')).toMatchObject({ scheduleKind: 'weekly', weekdays: [1, 3, 5] });
  });

  it('describes one-shot clock tasks and rejects bad clock input', async () => {
    const tool = makeTool();
    const once = await tool.handler({ action: 'create', name: '提醒', prompt: 'p', scheduleKind: 'weekly', weekdays: [5], timeOfDay: '10:00', once: true });
    expect(once.output).toContain('一次性，在下一个周五 10:00 执行');
    expect(await tool.handler({ action: 'create', name: 'x', prompt: 'p', scheduleKind: 'daily', timeOfDay: '25:00' }))
      .toMatchObject({ success: false, error: '执行时刻格式应为 HH:mm' });
    expect(await tool.handler({ action: 'create', name: 'x', prompt: 'p', scheduleKind: 'weekly', timeOfDay: '10:00' }))
      .toMatchObject({ success: false, error: '每周执行至少选择一天' });
  });

  it.each([
    ['Daily', 'daily'], ['每周', 'weekly'], ['interval', 'interval'], ['monthly', 'monthly'],
  ])('normalizeScheduleKind(%s) = %s', (raw, expected) => {
    expect(normalizeScheduleKind(raw)).toBe(expected);
  });

  it.each<[unknown, unknown]>([
    [[5], [5]], [['5'], [5]], ['fri', [5]], ['周一,周三、星期五', [1, 3, 5]], [7, [0]], [['Sunday'], [0]], [['周八'], ['周八']],
  ])('normalizeWeekdays(%j) = %j', (raw, expected) => {
    expect(normalizeWeekdays(raw)).toEqual(expected);
  });

  it('describes one-shot tasks and honours enabled:false', async () => {
    const res = await makeTool().handler({ ...createArgs, once: true, enabled: false });
    expect(res.success).toBe(true);
    expect((await store.list())[0]).toMatchObject({ once: true, enabled: false, nextRunAt: null });
    expect(res.output).toContain('一次性，启用 2 小时后执行');
    expect(res.output).toContain('已停用');
  });

  it('rejects invalid input and stores nothing', async () => {
    const tool = makeTool();
    const noPrompt = await tool.handler({ ...createArgs, prompt: '  ' });
    expect(noPrompt).toMatchObject({ success: false, error: '任务提示词不能为空' });
    const badUnit = await tool.handler({ ...createArgs, intervalUnit: 'weekly' });
    expect(badUnit).toMatchObject({ success: false, error: '任务间隔单位无效' });
    const badValue = await tool.handler({ ...createArgs, intervalValue: 1.5 });
    expect(badValue).toMatchObject({ success: false, error: '任务间隔必须是正整数' });
    expect(await store.list()).toHaveLength(0);
  });

  it('refuses a duplicate create with the same name and points at update', async () => {
    const tool = makeTool();
    expect((await tool.handler(createArgs)).success).toBe(true);
    const [task] = await store.list();
    const again = await tool.handler({ ...createArgs, name: ' 巡检 ', intervalValue: 3 });
    expect(again.success).toBe(false);
    expect(again.error).toContain(`已存在同名定时任务「巡检」（id=${task!.id}）`);
    expect(again.error).toContain('action:"update"');
    expect(await store.list()).toHaveLength(1);
    expect((await tool.handler({ ...createArgs, name: '巡检2' })).success).toBe(true);
  });

  it('refuses create inside a scheduled task session', async () => {
    const res = await makeTool(true).handler(createArgs);
    expect(res).toMatchObject({ success: false, error: SCHEDULED_TASK_CREATE_IN_TASK_SESSION_MESSAGE });
    expect(await store.list()).toHaveLength(0);
  });

  it('still allows managing tasks inside a scheduled task session', async () => {
    await makeTool().handler(createArgs);
    const [task] = await store.list();
    const res = await makeTool(true).handler({ action: 'toggle', id: task!.id, enabled: false });
    expect(res.success).toBe(true);
    expect((await store.get(task!.id))!.enabled).toBe(false);
  });

  it('warns about unknown skills but still creates the task', async () => {
    const res = await makeTool().handler({ ...createArgs, skillFilenames: ['review.md', 'nope.md'] });
    expect(res.success).toBe(true);
    expect(res.output).toContain('以下技能不存在，执行时会被忽略：nope.md');
    expect(res.output).toContain('可用技能：review.md');
    expect((await store.list())[0]!.skillFilenames).toEqual(['review.md', 'nope.md']);
  });

  it('lists tasks with schedule, status and prompt preview', async () => {
    const tool = makeTool();
    expect((await tool.handler({ action: 'list' })).output).toBe('当前没有定时任务。');
    await tool.handler(createArgs);
    await tool.handler({ ...createArgs, name: '日报', prompt: 'x'.repeat(200), intervalValue: 1, intervalUnit: 'day' });
    const res = await tool.handler({ action: 'list' });
    expect(res.output).toContain('共 2 个定时任务');
    expect(res.output).toContain('「巡检」');
    expect(res.output).toContain('每 1 天执行一次');
    expect(res.output).toContain(`提示词：${'x'.repeat(80)}…`);
  });

  it('updates only the provided fields and reschedules', async () => {
    const tool = makeTool();
    await tool.handler(createArgs);
    const [task] = await store.list();
    scheduler.reschedule.mockClear();
    now += 1000;
    const res = await tool.handler({ action: 'update', id: task!.id, intervalValue: 15, intervalUnit: 'minute' });
    expect(res.success).toBe(true);
    expect(await store.get(task!.id)).toMatchObject({
      name: '巡检',
      prompt: '检查依赖是否有安全更新',
      intervalValue: 15,
      intervalUnit: 'minute',
      nextRunAt: now + 15 * 60_000,
    });
    expect(scheduler.reschedule).toHaveBeenCalledTimes(1);
  });

  it('rejects update without fields and actions without id', async () => {
    const tool = makeTool();
    await tool.handler(createArgs);
    const [task] = await store.list();
    expect(await tool.handler({ action: 'update', id: task!.id })).toMatchObject({ success: false, error: '没有要修改的字段' });
    for (const action of ['update', 'toggle', 'delete', 'run']) {
      const res = await tool.handler({ action, name: 'x' });
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/缺少 id/);
    }
  });

  it('toggles without explicit enabled by flipping the state', async () => {
    const tool = makeTool();
    await tool.handler(createArgs);
    const [task] = await store.list();
    const off = await tool.handler({ action: 'toggle', id: task!.id });
    expect(off.output).toContain('已停用');
    const on = await tool.handler({ action: 'toggle', id: task!.id });
    expect(on.output).toContain('已启用');
    expect((await store.get(task!.id))!.enabled).toBe(true);
  });

  it('deletes a task and reports unknown ids', async () => {
    const tool = makeTool();
    await tool.handler(createArgs);
    const [task] = await store.list();
    const res = await tool.handler({ action: 'delete', id: task!.id });
    expect(res).toMatchObject({ success: true });
    expect(res.output).toContain('已删除定时任务「巡检」');
    expect(await store.list()).toHaveLength(0);
    const again = await tool.handler({ action: 'delete', id: task!.id });
    expect(again.success).toBe(false);
    expect(again.error).toMatch(/^定时任务不存在/);
  });

  it('runs a task now and surfaces the busy error', async () => {
    const tool = makeTool();
    await tool.handler(createArgs);
    const [task] = await store.list();
    const res = await tool.handler({ action: 'run', id: task!.id });
    expect(res.success).toBe(true);
    expect(scheduler.runNow).toHaveBeenCalledWith(task!.id);
    scheduler.runNow.mockRejectedValueOnce(new Error(SCHEDULED_TASK_BUSY_MESSAGE));
    expect(await tool.handler({ action: 'run', id: task!.id })).toMatchObject({ success: false, error: SCHEDULED_TASK_BUSY_MESSAGE });
  });

  it('rejects unknown actions', async () => {
    const res = await makeTool().handler({ action: 'schedule' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('list / create / update / toggle / delete / run');
  });
});
