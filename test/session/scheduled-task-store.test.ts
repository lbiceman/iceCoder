import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as atomicWrite from '../../src/memory/file-memory/atomic-write.js';
import {
  ScheduledTaskStore,
  advanceSchedule,
  advanceToFuture,
  intervalToMs,
  nextClockRunAt,
  normalizeSchedule,
  normalizeTimeOfDay,
  type ScheduledTaskIntervalUnit,
  type ScheduledTaskSchedule,
} from '../../src/session/scheduled-task-store.js';

const at = (...parts: [number, number, number, number?, number?]) =>
  new Date(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0).getTime();

function clock(overrides: Partial<ScheduledTaskSchedule>): ScheduledTaskSchedule {
  return { scheduleKind: 'daily', intervalValue: 1, intervalUnit: 'day', timeOfDay: '00:00', weekdays: [], monthDays: [], ...overrides };
}

describe('钟点调度计算（本地时区）', () => {
  it('每天 00:00：23:59 之后是次日零点，正好零点时取下一天', () => {
    const daily = clock({ timeOfDay: '00:00' });
    expect(nextClockRunAt(daily, at(2026, 10, 12, 23, 59))).toBe(at(2026, 10, 13));
    expect(nextClockRunAt(daily, at(2026, 10, 13))).toBe(at(2026, 10, 14));
    expect(nextClockRunAt(daily, at(2026, 10, 31, 12))).toBe(at(2026, 11, 1));
    expect(nextClockRunAt(daily, at(2026, 12, 31, 23, 30))).toBe(at(2027, 1, 1));
  });

  it('每周五 10:00：周五 9:59 当天执行，10:00 及之后到下周五', () => {
    const friday = clock({ scheduleKind: 'weekly', weekdays: [5], timeOfDay: '10:00' });
    // 2026-10-16 是周五。
    expect(nextClockRunAt(friday, at(2026, 10, 12, 16, 36))).toBe(at(2026, 10, 16, 10));
    expect(nextClockRunAt(friday, at(2026, 10, 16, 9, 59))).toBe(at(2026, 10, 16, 10));
    expect(nextClockRunAt(friday, at(2026, 10, 16, 10))).toBe(at(2026, 10, 23, 10));
    expect(nextClockRunAt(friday, at(2026, 10, 16, 10, 1))).toBe(at(2026, 10, 23, 10));
  });

  it('多个星期取最近的一天，周日为 0', () => {
    const monWedSun = clock({ scheduleKind: 'weekly', weekdays: [0, 1, 3], timeOfDay: '08:30' });
    expect(nextClockRunAt(monWedSun, at(2026, 10, 12, 9))).toBe(at(2026, 10, 14, 8, 30));
    expect(nextClockRunAt(monWedSun, at(2026, 10, 17, 9))).toBe(at(2026, 10, 18, 8, 30));
  });

  it('每月 15 日 09:00：当月未到取当月，已过取下月，跨年', () => {
    const mid = clock({ scheduleKind: 'monthly', monthDays: [15], timeOfDay: '09:00' });
    expect(nextClockRunAt(mid, at(2026, 10, 12, 16, 36))).toBe(at(2026, 10, 15, 9));
    expect(nextClockRunAt(mid, at(2026, 10, 15, 8, 59))).toBe(at(2026, 10, 15, 9));
    expect(nextClockRunAt(mid, at(2026, 10, 15, 9))).toBe(at(2026, 11, 15, 9));
    expect(nextClockRunAt(mid, at(2026, 12, 20))).toBe(at(2027, 1, 15, 9));
  });

  it('每月 1 日：月初刚过要等满一个月（31 天的月份）', () => {
    const first = clock({ scheduleKind: 'monthly', monthDays: [1], timeOfDay: '00:00' });
    expect(nextClockRunAt(first, at(2026, 1, 1, 0, 1))).toBe(at(2026, 2, 1));
    expect(nextClockRunAt(first, at(2026, 12, 1, 0, 0))).toBe(at(2027, 1, 1));
  });

  it('每月 31 日：小月和 2 月落到当月最后一天，闰年 2 月 29 日', () => {
    const last = clock({ scheduleKind: 'monthly', monthDays: [31], timeOfDay: '18:00' });
    expect(nextClockRunAt(last, at(2026, 1, 31, 18))).toBe(at(2026, 2, 28, 18));
    expect(nextClockRunAt(last, at(2026, 2, 28, 18))).toBe(at(2026, 3, 31, 18));
    expect(nextClockRunAt(last, at(2026, 4, 1))).toBe(at(2026, 4, 30, 18));
    expect(nextClockRunAt(last, at(2028, 2, 1))).toBe(at(2028, 2, 29, 18));
    // 30 日与 31 日在 2 月重合为同一天，只执行一次，之后回到 3 月 30 日。
    const both = clock({ scheduleKind: 'monthly', monthDays: [30, 31], timeOfDay: '18:00' });
    expect(nextClockRunAt(both, at(2026, 2, 1))).toBe(at(2026, 2, 28, 18));
    expect(nextClockRunAt(both, at(2026, 2, 28, 18))).toBe(at(2026, 3, 30, 18));
    expect(nextClockRunAt(both, at(2026, 3, 30, 18))).toBe(at(2026, 3, 31, 18));
  });

  it('每月多天取最近的一天', () => {
    const days = clock({ scheduleKind: 'monthly', monthDays: [1, 10, 20], timeOfDay: '08:00' });
    expect(nextClockRunAt(days, at(2026, 10, 12))).toBe(at(2026, 10, 20, 8));
    expect(nextClockRunAt(days, at(2026, 10, 25))).toBe(at(2026, 11, 1, 8));
  });

  it('advanceSchedule：钟点任务取 now 之后最近时刻，间隔任务按原节拍推进', () => {
    const daily = clock({ timeOfDay: '00:00' });
    expect(advanceSchedule(daily, at(2026, 10, 13), at(2026, 10, 13, 0, 0) + 5)).toBe(at(2026, 10, 14));
    expect(advanceSchedule(daily, at(2026, 10, 10), at(2026, 10, 13, 8))).toBe(at(2026, 10, 14));
    const interval = clock({ scheduleKind: 'interval', intervalValue: 1, intervalUnit: 'second' });
    expect(advanceSchedule(interval, 1_000, 4_500)).toBe(5_000);
  });

  it('normalizeTimeOfDay：补零、24:00 记为 00:00、拒绝非法值', () => {
    expect(normalizeTimeOfDay('9:05')).toBe('09:05');
    expect(normalizeTimeOfDay(' 10:00 ')).toBe('10:00');
    expect(normalizeTimeOfDay('24:00')).toBe('00:00');
    for (const bad of ['24:30', '23:60', '10', '10:0', 'ab:cd', '', 1000, undefined]) {
      expect(() => normalizeTimeOfDay(bad), String(bad)).toThrow('执行时刻格式应为 HH:mm');
    }
  });

  it('normalizeSchedule：只校验当前方式用到的字段，其余清空', () => {
    expect(normalizeSchedule({ scheduleKind: 'weekly', weekdays: [5, 1, 5], timeOfDay: '10:00', monthDays: [3] })).toEqual({
      scheduleKind: 'weekly', intervalValue: 1, intervalUnit: 'day', timeOfDay: '10:00', weekdays: [1, 5], monthDays: [],
    });
    expect(normalizeSchedule({ scheduleKind: 'monthly', monthDays: [31, 1, 31], weekdays: [2], timeOfDay: '10:00' })).toEqual({
      scheduleKind: 'monthly', intervalValue: 1, intervalUnit: 'day', timeOfDay: '10:00', weekdays: [], monthDays: [1, 31],
    });
    expect(normalizeSchedule({ scheduleKind: 'daily', timeOfDay: '00:00', weekdays: [3], intervalValue: 2, intervalUnit: 'hour' }))
      .toEqual({ scheduleKind: 'daily', intervalValue: 2, intervalUnit: 'hour', timeOfDay: '00:00', weekdays: [], monthDays: [] });
    expect(normalizeSchedule({ intervalValue: 5, intervalUnit: 'minute', timeOfDay: '10:00' }))
      .toMatchObject({ scheduleKind: 'interval', timeOfDay: '', weekdays: [], monthDays: [] });
    expect(() => normalizeSchedule({ scheduleKind: 'yearly' as never, timeOfDay: '10:00' })).toThrow('调度方式无效');
    expect(() => normalizeSchedule({ scheduleKind: 'monthly', timeOfDay: '10:00' })).toThrow('每月执行至少选择一天');
    for (const bad of [0, 32, 1.5]) {
      expect(() => normalizeSchedule({ scheduleKind: 'monthly', timeOfDay: '10:00', monthDays: [bad] }), String(bad))
        .toThrow('日期取值应为 1-31 的整数');
    }
    expect(() => normalizeSchedule({ scheduleKind: 'daily' })).toThrow('执行时刻格式应为 HH:mm');
    expect(() => normalizeSchedule({ scheduleKind: 'weekly', timeOfDay: '10:00', weekdays: [] })).toThrow('每周执行至少选择一天');
    expect(() => normalizeSchedule({ scheduleKind: 'weekly', timeOfDay: '10:00', weekdays: [7] })).toThrow('星期取值应为 0-6');
    expect(() => normalizeSchedule({ scheduleKind: 'weekly', timeOfDay: '10:00', weekdays: [1.5] })).toThrow('星期取值应为 0-6');
  });
});

describe('scheduled task store', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function fixture(now = 1_000) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-scheduled-'));
    dirs.push(dir);
    const filePath = path.join(dir, 'scheduled-tasks.json');
    return { store: new ScheduledTaskStore(filePath, () => now), filePath };
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      name: '日报',
      prompt: '生成日报',
      skillFilenames: [],
      intervalValue: 5,
      intervalUnit: 'minute' as ScheduledTaskIntervalUnit,
      sessionId: 'session-1',
      enabled: true,
      ...overrides,
    };
  }

  it('只支持秒分时天并换算为毫秒', () => {
    expect(intervalToMs(2, 'second')).toBe(2_000);
    expect(intervalToMs(2, 'minute')).toBe(120_000);
    expect(intervalToMs(2, 'hour')).toBe(7_200_000);
    expect(intervalToMs(2, 'day')).toBe(172_800_000);
  });

  it('把错过多次的时间直接推进到未来', () => {
    expect(advanceToFuture(1_000, 1_000, 4_500)).toBe(5_000);
    expect(advanceToFuture(5_000, 1_000, 4_500)).toBe(5_000);
  });

  it('Store 构造函数接受 filePath 与可选 now', () => {
    const store = new ScheduledTaskStore('/tmp/tasks.json');
    expect(store).toBeInstanceOf(ScheduledTaskStore);
    const storeWithNow = new ScheduledTaskStore('/tmp/tasks.json', () => 42);
    expect(storeWithNow).toBeInstanceOf(ScheduledTaskStore);
  });

  it('创建启用任务时等待一个完整间隔', async () => {
    const { store } = await fixture();
    const task = await store.create(baseInput());
    expect(task.nextRunAt).toBe(301_000);
    expect((await store.list()).map((t) => t.id)).toEqual([task.id]);
  });

  it('新建任务可以没有会话（首次执行时再创建），重开文件后仍为空', async () => {
    const { store, filePath } = await fixture();
    const task = await store.create(baseInput({ sessionId: '' }));
    expect(task.sessionId).toBe('');
    expect((await new ScheduledTaskStore(filePath).get(task.id))?.sessionId).toBe('');
  });

  it('使用调用方预先生成的 id，重复 id 拒绝', async () => {
    const { store } = await fixture();
    const task = await store.create(baseInput({ id: 'pre-made' }));
    expect(task.id).toBe('pre-made');
    await expect(store.create(baseInput({ id: 'pre-made' }))).rejects.toThrow('定时任务 id 已存在');
    expect(await store.list()).toHaveLength(1);
  });

  it('拒绝空名称', async () => {
    const { store } = await fixture();
    await expect(store.create(baseInput({ name: ' ' }))).rejects.toThrow('任务名称不能为空');
  });

  it('拒绝空提示词', async () => {
    const { store } = await fixture();
    await expect(store.create(baseInput({ prompt: ' ' }))).rejects.toThrow('任务提示词不能为空');
  });

  it('拒绝非正整数间隔', async () => {
    const { store } = await fixture();
    await expect(store.create(baseInput({ intervalValue: 0 }))).rejects.toThrow(
      '任务间隔必须是正整数',
    );
    await expect(store.create(baseInput({ intervalValue: 1.5 }))).rejects.toThrow(
      '任务间隔必须是正整数',
    );
  });

  it('拒绝非法间隔单位', async () => {
    const { store } = await fixture();
    await expect(
      store.create(baseInput({ intervalUnit: 'week' as ScheduledTaskIntervalUnit })),
    ).rejects.toThrow('任务间隔单位无效');
  });

  it('停用任务 nextRunAt 为 null', async () => {
    const { store } = await fixture();
    const task = await store.create(baseInput({ enabled: false }));
    expect(task.nextRunAt).toBeNull();
  });

  it('编辑与删除在重新打开同一文件后仍然生效', async () => {
    const { store, filePath } = await fixture();
    const created = await store.create(baseInput({ name: '原始名称' }));

    const editor = new ScheduledTaskStore(filePath, () => 1_000);
    await editor.update(created.id, { name: '  新名称  ', prompt: '新提示词' });

    const reader = new ScheduledTaskStore(filePath, () => 1_000);
    const reloaded = await reader.get(created.id);
    expect(reloaded?.name).toBe('新名称');
    expect(reloaded?.prompt).toBe('新提示词');

    const deleter = new ScheduledTaskStore(filePath, () => 1_000);
    await deleter.remove(created.id);

    const verifier = new ScheduledTaskStore(filePath, () => 1_000);
    expect(await verifier.list()).toEqual([]);
  });

  it('并发 create 不会丢失任务', async () => {
    const { store } = await fixture();
    const tasks = await Promise.all([
      store.create(baseInput({ name: '任务 A', sessionId: 's-a' })),
      store.create(baseInput({ name: '任务 B', sessionId: 's-b' })),
      store.create(baseInput({ name: '任务 C', sessionId: 's-c' })),
    ]);
    const listed = await store.list();
    expect(listed).toHaveLength(3);
    expect(new Set(listed.map((t) => t.id))).toEqual(new Set(tasks.map((t) => t.id)));
  });

  it('返回的任务对象是克隆，调用方不能篡改内部状态', async () => {
    const { store } = await fixture();
    const task = await store.create(baseInput());
    task.name = '被篡改';
    task.skillFilenames.push('evil.md');

    const fromGet = await store.get(task.id);
    expect(fromGet?.name).toBe('日报');
    expect(fromGet?.skillFilenames).toEqual([]);

    const listed = await store.list();
    expect(listed[0]?.name).toBe('日报');
    expect(listed[0]?.skillFilenames).toEqual([]);
  });

  it('normalize skillFilenames：trim、去空、去重', async () => {
    const { store } = await fixture();
    const task = await store.create(
      baseInput({ skillFilenames: [' a.md ', '', 'a.md', 'b.md', '  '] }),
    );
    expect(task.skillFilenames).toEqual(['a.md', 'b.md']);
  });

  it('附件字段：创建默认为空，update 仅在传入时替换', async () => {
    const { store } = await fixture();
    const created = await store.create(baseInput());
    expect(created.images).toEqual([]);
    expect(created.files).toEqual([]);

    const file = { id: 'f1', name: 'a.txt', path: '/data/f1/a.txt', size: 3 };
    const image = { id: 'i1', name: 'x.png', path: '/data/i1/x.png', size: 4 };
    const withAttachments = await store.update(created.id, { images: [image], files: [file] });
    expect(withAttachments.images).toEqual([image]);
    expect(withAttachments.files).toEqual([file]);

    const renamed = await store.update(created.id, { name: '改名' });
    expect(renamed.images).toEqual([image]);
    expect(renamed.files).toEqual([file]);
  });

  it('旧版本的会话图片 URL 读入 legacyImageUrls，写入新图片列表后清除', async () => {
    const { store, filePath } = await fixture();
    const image = { id: 'i1', name: 'x.png', path: '/data/i1/x.png', size: 4 };
    const legacy = {
      id: 'old', name: '旧任务', prompt: 'p', skillFilenames: [], intervalValue: 1, intervalUnit: 'hour',
      sessionId: 's', enabled: true, createdAt: 0, updatedAt: 0, lastRunAt: null, nextRunAt: 3_600_000,
      lastStatus: 'idle', lastError: null, files: [], images: ['/api/sessions/s/images/a.png', image],
    };
    await fs.writeFile(filePath, JSON.stringify({ version: 1, tasks: [legacy] }), 'utf-8');

    const [loaded] = await store.list();
    expect(loaded).toMatchObject({ images: [image], legacyImageUrls: ['/api/sessions/s/images/a.png'] });
    expect((await store.update('old', { name: '改名' })).legacyImageUrls).toEqual(['/api/sessions/s/images/a.png']);

    const migrated = await store.update('old', { images: [image] });
    expect(migrated.legacyImageUrls).toBeUndefined();
    const reloaded = new ScheduledTaskStore(filePath, () => 1_000);
    expect((await reloaded.get('old'))?.legacyImageUrls).toBeUndefined();
  });

  it('读取旧版本无附件字段的任务时补齐为空数组', async () => {
    const { store, filePath } = await fixture();
    const legacy = {
      id: 'old', name: '旧任务', prompt: 'p', skillFilenames: [], intervalValue: 1, intervalUnit: 'hour',
      sessionId: 's', enabled: false, createdAt: 0, updatedAt: 0, lastRunAt: null, nextRunAt: null,
      lastStatus: 'idle', lastError: null,
    };
    await fs.writeFile(filePath, JSON.stringify({ version: 1, tasks: [legacy] }), 'utf-8');
    const [task] = await store.list();
    expect(task).toMatchObject({
      id: 'old', images: [], files: [], once: false, scheduleKind: 'interval', timeOfDay: '', weekdays: [], monthDays: [],
    });
  });

  it('创建每天 / 每周任务：首次执行在下一个匹配时刻，重开文件后字段保留', async () => {
    const { store, filePath } = await fixture(at(2026, 10, 12, 16, 36));
    const daily = await store.create(baseInput({ scheduleKind: 'daily', timeOfDay: '24:00', intervalValue: undefined, intervalUnit: undefined }));
    expect(daily).toMatchObject({ scheduleKind: 'daily', timeOfDay: '00:00', weekdays: [], intervalValue: 1, intervalUnit: 'day' });
    expect(daily.nextRunAt).toBe(at(2026, 10, 13));

    const weekly = await store.create(baseInput({ name: '周报', scheduleKind: 'weekly', weekdays: [5], timeOfDay: '10:00' }));
    expect(weekly.nextRunAt).toBe(at(2026, 10, 16, 10));

    const reloaded = await new ScheduledTaskStore(filePath).get(weekly.id);
    expect(reloaded).toMatchObject({ scheduleKind: 'weekly', weekdays: [5], timeOfDay: '10:00' });

    const monthly = await store.create(baseInput({ name: '月报', scheduleKind: 'monthly', monthDays: [1], timeOfDay: '09:00' }));
    expect(monthly.nextRunAt).toBe(at(2026, 11, 1, 9));
    expect(await new ScheduledTaskStore(filePath).get(monthly.id))
      .toMatchObject({ scheduleKind: 'monthly', monthDays: [1], weekdays: [], timeOfDay: '09:00' });
  });

  it('修改每月日期时重算 nextRunAt，切走后清空 monthDays', async () => {
    let now = at(2026, 10, 12, 16, 36);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-scheduled-'));
    dirs.push(dir);
    const store = new ScheduledTaskStore(path.join(dir, 'scheduled-tasks.json'), () => now);
    const task = await store.create(baseInput({ scheduleKind: 'monthly', monthDays: [20], timeOfDay: '10:00' }));
    expect(task.nextRunAt).toBe(at(2026, 10, 20, 10));

    now = at(2026, 10, 13);
    expect((await store.update(task.id, { name: '改名' })).nextRunAt).toBe(at(2026, 10, 20, 10));
    expect((await store.update(task.id, { monthDays: [1] })).nextRunAt).toBe(at(2026, 11, 1, 10));
    const daily = await store.update(task.id, { scheduleKind: 'daily' });
    expect(daily).toMatchObject({ scheduleKind: 'daily', monthDays: [], timeOfDay: '10:00' });
    expect(daily.nextRunAt).toBe(at(2026, 10, 13, 10));
    await expect(store.update(task.id, { scheduleKind: 'monthly' })).rejects.toThrow('每月执行至少选择一天');
  });

  it('修改钟点计划或切换调度方式时重算 nextRunAt，只改名称不影响', async () => {
    let now = at(2026, 10, 12, 16, 36);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-scheduled-'));
    dirs.push(dir);
    const store = new ScheduledTaskStore(path.join(dir, 'scheduled-tasks.json'), () => now);
    const task = await store.create(baseInput({ scheduleKind: 'daily', timeOfDay: '00:00' }));
    expect(task.nextRunAt).toBe(at(2026, 10, 13));

    now = at(2026, 10, 12, 17);
    expect((await store.update(task.id, { name: '改名', intervalValue: 3 })).nextRunAt).toBe(at(2026, 10, 13));
    expect((await store.update(task.id, { timeOfDay: '18:00' })).nextRunAt).toBe(at(2026, 10, 12, 18));

    const weekly = await store.update(task.id, { scheduleKind: 'weekly', weekdays: [5], timeOfDay: '10:00' });
    expect(weekly.nextRunAt).toBe(at(2026, 10, 16, 10));

    const backToInterval = await store.update(task.id, { scheduleKind: 'interval' });
    expect(backToInterval).toMatchObject({ scheduleKind: 'interval', intervalValue: 3, intervalUnit: 'minute', timeOfDay: '', weekdays: [] });
    expect(backToInterval.nextRunAt).toBe(now + 3 * 60_000);

    await expect(store.update(task.id, { scheduleKind: 'daily' })).rejects.toThrow('执行时刻格式应为 HH:mm');
  });

  it('once：创建缺省为 false，update 仅在传入时修改并持久化', async () => {
    const { store, filePath } = await fixture();
    expect((await store.create(baseInput())).once).toBe(false);

    const created = await store.create(baseInput({ once: true, sessionId: 's-once' }));
    expect(created.once).toBe(true);
    expect((await store.update(created.id, { name: '改名' })).once).toBe(true);
    expect((await store.update(created.id, { once: false })).once).toBe(false);

    const reloaded = new ScheduledTaskStore(filePath, () => 1_000);
    expect((await reloaded.get(created.id))?.once).toBe(false);
  });

  it('update 保留 id、sessionId、createdAt', async () => {
    const { store } = await fixture();
    const created = await store.create(baseInput());
    const updated = await store.update(created.id, {
      name: '新名',
      sessionId: 'should-not-change',
    });
    expect(updated.id).toBe(created.id);
    expect(updated.sessionId).toBe('session-1');
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('修改间隔或从停用到启用时重置 nextRunAt', async () => {
    const { store } = await fixture(10_000);
    const created = await store.create(baseInput({ intervalValue: 1, intervalUnit: 'minute' }));
    expect(created.nextRunAt).toBe(70_000);

    const intervalChanged = await store.update(created.id, { intervalValue: 2 });
    expect(intervalChanged.nextRunAt).toBe(130_000);

    const disabled = await store.update(created.id, { enabled: false });
    expect(disabled.nextRunAt).toBeNull();

    const reenabled = await store.update(created.id, { enabled: true });
    expect(reenabled.nextRunAt).toBe(130_000);
  });

  it('停用时 nextRunAt 设为 null', async () => {
    const { store } = await fixture();
    const created = await store.create(baseInput());
    const disabled = await store.update(created.id, { enabled: false });
    expect(disabled.nextRunAt).toBeNull();
  });

  it('updateRunState 只更新 lastRunAt、lastStatus、lastError', async () => {
    let now = 1_000;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-scheduled-'));
    dirs.push(dir);
    const filePath = path.join(dir, 'scheduled-tasks.json');
    const store = new ScheduledTaskStore(filePath, () => now);
    const created = await store.create(baseInput());
    now = 9_999;
    const updated = await store.updateRunState(created.id, {
      lastRunAt: 2_000,
      lastStatus: 'success',
      lastError: null,
    });
    expect(updated.lastRunAt).toBe(2_000);
    expect(updated.lastStatus).toBe('success');
    expect(updated.name).toBe('日报');
    expect(updated.updatedAt).toBe(created.updatedAt);
    expect(updated.nextRunAt).toBe(created.nextRunAt);
    expect(updated.enabled).toBe(created.enabled);
  });

  it('create 写盘失败时不改变内存中的任务列表', async () => {
    const { store } = await fixture();
    const existing = await store.create(baseInput({ name: '已有任务', sessionId: 's0' }));
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      store.create(baseInput({ name: '新任务', sessionId: 's1' })),
    ).rejects.toThrow('disk full');
    spy.mockRestore();
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(existing.id);
  });

  it('update 写盘失败时不改变内存中的任务列表', async () => {
    const { store } = await fixture();
    const created = await store.create(baseInput());
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.update(created.id, { name: '应失败' })).rejects.toThrow('disk full');
    spy.mockRestore();
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('日报');
  });

  it('replaceNextRunAt 写盘失败时 nextRunAt 保持原值', async () => {
    const { store } = await fixture();
    const created = await store.create(baseInput());
    const originalNextRunAt = created.nextRunAt;
    const spy = vi.spyOn(atomicWrite, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.replaceNextRunAt(created.id, 999_999)).rejects.toThrow('disk full');
    spy.mockRestore();
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.nextRunAt).toBe(originalNextRunAt);
  });

  it('replaceNextRunAt 只更新 nextRunAt 与 updatedAt', async () => {
    const { store } = await fixture();
    const created = await store.create(baseInput());
    const replaced = await store.replaceNextRunAt(created.id, 999_999);
    expect(replaced.nextRunAt).toBe(999_999);
    expect(replaced.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    expect(replaced.name).toBe('日报');
  });

  it('损坏或非数组的持久化数据加载为空列表', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { store, filePath } = await fixture();
    await store.create(baseInput());
    await fs.writeFile(filePath, '{ "version": 1, "tasks": "bad" }', 'utf-8');
    const reloaded = new ScheduledTaskStore(filePath, () => 1_000);
    expect(await reloaded.list()).toEqual([]);

    await fs.writeFile(filePath, 'not json', 'utf-8');
    const corrupt = new ScheduledTaskStore(filePath, () => 1_000);
    expect(await corrupt.list()).toEqual([]);
  });

  it('无法解析的任务文件先备份，之后的写入不会覆盖掉原内容', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { filePath } = await fixture();
    await fs.writeFile(filePath, '{"version":1,"tasks":[{"id":"keep"', 'utf-8');
    const store = new ScheduledTaskStore(filePath, () => 2_000);
    expect(await store.list()).toEqual([]);
    await store.create(baseInput());
    const backups = (await fs.readdir(path.dirname(filePath))).filter((f) => f.includes('.broken-'));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(path.dirname(filePath), backups[0]!), 'utf-8'))
      .toBe('{"version":1,"tasks":[{"id":"keep"');
  });

  it('onChange 在每次写盘后通知，写盘失败与只读操作不通知', async () => {
    const { store } = await fixture();
    const listener = vi.fn();
    store.onChange(listener);
    const task = await store.create(baseInput());
    await store.update(task.id, { enabled: false });
    await store.rebindSession(task.id, 'session-2');
    await store.list();
    await store.get(task.id);
    expect(listener).toHaveBeenCalledTimes(3);

    vi.spyOn(atomicWrite, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'));
    await expect(store.remove(task.id)).rejects.toThrow('disk full');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('onChange 监听器抛错不影响写入结果', async () => {
    const { store } = await fixture();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.onChange(() => { throw new Error('listener boom'); });
    const task = await store.create(baseInput());
    expect(await store.get(task.id)).toBeTruthy();
  });

  it('读文件出现非 ENOENT 的 IO 错误时报错且不缓存空列表', async () => {
    const { store, filePath } = await fixture();
    await fs.writeFile(filePath, JSON.stringify({ version: 1, tasks: [] }), 'utf-8');
    const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(busy);
    await expect(store.list()).rejects.toThrow('EBUSY');
    await store.create(baseInput());
    expect(await store.list()).toHaveLength(1);
  });
});
