import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as atomicWrite from '../../src/memory/file-memory/atomic-write.js';
import {
  ScheduledTaskStore,
  advanceToFuture,
  intervalToMs,
  type ScheduledTaskIntervalUnit,
} from '../../src/session/scheduled-task-store.js';

describe('scheduled task store', () => {
  const dirs: string[] = [];

  afterEach(async () => {
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
    const withAttachments = await store.update(created.id, { images: ['/api/sessions/s/images/x.png'], files: [file] });
    expect(withAttachments.images).toEqual(['/api/sessions/s/images/x.png']);
    expect(withAttachments.files).toEqual([file]);

    const renamed = await store.update(created.id, { name: '改名' });
    expect(renamed.images).toEqual(['/api/sessions/s/images/x.png']);
    expect(renamed.files).toEqual([file]);
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
    expect(task).toMatchObject({ id: 'old', images: [], files: [] });
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
    const { store, filePath } = await fixture();
    await store.create(baseInput());
    await fs.writeFile(filePath, '{ "version": 1, "tasks": "bad" }', 'utf-8');
    const reloaded = new ScheduledTaskStore(filePath, () => 1_000);
    expect(await reloaded.list()).toEqual([]);

    await fs.writeFile(filePath, 'not json', 'utf-8');
    const corrupt = new ScheduledTaskStore(filePath, () => 1_000);
    expect(await corrupt.list()).toEqual([]);
  });
});
