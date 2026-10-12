import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TIMEOUT_MS,
  ScheduledTaskScheduler,
} from '../../src/session/scheduled-task-scheduler.js';
import type {
  ScheduledTask,
  ScheduledTaskRunStatePatch,
} from '../../src/session/scheduled-task-store.js';

function task(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't',
    name: 'task',
    prompt: 'do it',
    skillFilenames: [],
    intervalValue: 10,
    intervalUnit: 'second',
    sessionId: 's1',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: 'idle',
    lastError: null,
    ...overrides,
  };
}

function fakeStore(initial: ScheduledTask[], events: string[] = []) {
  const rows = initial.map((t) => structuredClone(t));
  const find = (id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`定时任务不存在: ${id}`);
    return row;
  };
  let listGate: Promise<void> | null = null;
  const listFailures: boolean[] = [];
  const replaceFailures = new Map<string, number>();
  const store = {
    rows,
    events,
    add(t: ScheduledTask) {
      rows.push(structuredClone(t));
    },
    /** 阻塞后续 list 调用；返回的函数放行，其 `.reject` 让被阻塞的调用失败。 */
    holdList() {
      let release!: () => void;
      let rejectGate!: (err: Error) => void;
      listGate = new Promise<void>((resolve, reject) => {
        release = resolve;
        rejectGate = reject;
      });
      return Object.assign(
        () => {
          listGate = null;
          release();
        },
        {
          reject: (err: Error) => {
            listGate = null;
            rejectGate(err);
          },
        },
      );
    },
    /** 依次决定后续 list 调用是否失败（true = 失败）。 */
    failLists(...flags: boolean[]) {
      listFailures.push(...flags);
    },
    failReplace(id: string, times: number) {
      replaceFailures.set(id, times);
    },
    list: vi.fn(async () => {
      if (listGate) await listGate;
      if (listFailures.length > 0 && listFailures.shift()) throw new Error('list down');
      return rows.map((r) => structuredClone(r));
    }),
    get: vi.fn(async (id: string) => {
      const row = rows.find((r) => r.id === id);
      return row ? structuredClone(row) : undefined;
    }),
    replaceNextRunAt: vi.fn(async (id: string, nextRunAt: number) => {
      const remaining = replaceFailures.get(id) ?? 0;
      if (remaining > 0) {
        replaceFailures.set(id, remaining - 1);
        throw new Error('replace down');
      }
      const row = find(id);
      row.nextRunAt = nextRunAt;
      events.push(`persist:${id}:${nextRunAt}`);
      return structuredClone(row);
    }),
    updateRunState: vi.fn(async (id: string, patch: ScheduledTaskRunStatePatch) => {
      const row = find(id);
      Object.assign(row, patch);
      return structuredClone(row);
    }),
  };
  return store;
}

function build(
  store: ReturnType<typeof fakeStore>,
  execute: (t: ScheduledTask) => Promise<void> = async () => {},
) {
  const exec = vi.fn(execute);
  const scheduler = new ScheduledTaskScheduler({
    store: store as never,
    execute: exec,
    now: () => Date.now(),
  });
  return { scheduler, execute: exec };
}

describe('ScheduledTaskScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('任何时刻只安排最近任务的一个 setTimeout', async () => {
    const store = fakeStore([
      task({ id: 'later', nextRunAt: 20_000 }),
      task({ id: 'near', nextRunAt: 10_000 }),
    ]);
    const { scheduler, execute } = build(store);
    await scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'near' }));
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
  });

  it('同一时刻到点的任务全部执行且单个失败不阻断', async () => {
    const store = fakeStore([
      task({ id: 'bad', nextRunAt: 1_000 }),
      task({ id: 'good', nextRunAt: 1_000 }),
    ]);
    const { scheduler, execute } = build(store, async (t) => {
      if (t.id === 'bad') throw new Error('boom');
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(store.rows.find((r) => r.id === 'bad')!.lastStatus).toBe('error');
    expect(store.rows.find((r) => r.id === 'good')!.lastStatus).toBe('queued');
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
  });

  it('到点任务先持久化下次时间，再调用执行器', async () => {
    const events: string[] = [];
    const store = fakeStore(
      [task({ id: 'a', nextRunAt: 1_000 }), task({ id: 'b', nextRunAt: 1_000 })],
      events,
    );
    const { scheduler } = build(store, async (t) => {
      events.push(`exec:${t.id}`);
    });
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toEqual([
      'persist:a:11000',
      'persist:b:11000',
      'exec:a',
      'exec:b',
    ]);
    scheduler.stop();
  });

  it('立即执行不修改周期时间', async () => {
    const store = fakeStore([task({ id: 'manual', nextRunAt: 9_000 })]);
    const { scheduler, execute } = build(store);
    await scheduler.runNow('manual');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'manual' }));
    expect(store.replaceNextRunAt).not.toHaveBeenCalled();
    expect(store.rows[0]!.nextRunAt).toBe(9_000);
  });

  it('立即执行未知任务时拒绝并给出不存在错误', async () => {
    const store = fakeStore([]);
    const { scheduler, execute } = build(store);
    await expect(scheduler.runNow('missing')).rejects.toThrow('定时任务不存在: missing');
    expect(execute).not.toHaveBeenCalled();
  });

  it('start 将过期任务推进到未来且不补跑', async () => {
    vi.setSystemTime(35_000);
    const store = fakeStore([
      task({ id: 'stale', nextRunAt: 1_000 }),
      task({ id: 'off', enabled: false, nextRunAt: null }),
    ]);
    const { scheduler, execute } = build(store);
    await scheduler.start();
    expect(execute).not.toHaveBeenCalled();
    expect(store.replaceNextRunAt).toHaveBeenCalledTimes(1);
    expect(store.replaceNextRunAt).toHaveBeenCalledWith('stale', 41_000);
    expect(store.rows.find((r) => r.id === 'stale')!.nextRunAt).toBe(41_000);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
  });

  it('新增更近任务后 reschedule 替换而不是叠加旧计时器', async () => {
    const store = fakeStore([task({ id: 'far', nextRunAt: 10_000 })]);
    const { scheduler, execute } = build(store);
    await scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    store.add(task({ id: 'near', nextRunAt: 5_000 }));
    await scheduler.reschedule();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 'near' }));
    scheduler.stop();
  });

  it('reschedule 等待进行中的 wake 完成后再重排', async () => {
    const store = fakeStore([task({ id: 'a', nextRunAt: 1_000 })]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler, execute } = build(store, () => gate);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    store.add(task({ id: 'b', nextRunAt: 3_000 }));
    let done = false;
    const pending = scheduler.reschedule().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    release();
    await pending;
    expect(vi.getTimerCount()).toBe(1);
    scheduler.stop();
  });

  it('stop 清除计时器，后续异步完成不会重新安排', async () => {
    const store = fakeStore([task({ id: 'a', nextRunAt: 5_000 })]);
    const { scheduler } = build(store);
    const release = store.holdList();
    const starting = scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    scheduler.stop();
    release();
    await starting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop 发生在重排扫描期间时不会重新安排', async () => {
    const store = fakeStore([task({ id: 'a', nextRunAt: 5_000 })]);
    const { scheduler } = build(store);
    await scheduler.start();
    const release = store.holdList();
    const rescheduling = scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    release();
    await rescheduling;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop 后进行中的 wake 结束时不会重新安排', async () => {
    const store = fakeStore([task({ id: 'a', nextRunAt: 1_000 })]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler } = build(store, () => gate);
    await scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop 后已排队但未开始的 wake 不执行任务', async () => {
    const store = fakeStore([task({ id: 'a', nextRunAt: 1_000 })]);
    const { scheduler, execute } = build(store);
    await scheduler.start();
    const release = store.holdList();
    await vi.advanceTimersByTimeAsync(1_000);
    scheduler.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('远期目标按 MAX_TIMEOUT_MS 封顶且到达上限时不提前执行', async () => {
    const target = MAX_TIMEOUT_MS * 2 + 500;
    const store = fakeStore([task({ id: 'far', nextRunAt: target })]);
    const { scheduler, execute } = build(store);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    await scheduler.start();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS);
    expect(execute).not.toHaveBeenCalled();
    expect(store.replaceNextRunAt).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), MAX_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS);
    expect(execute).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 500);

    await vi.advanceTimersByTimeAsync(500);
    expect(execute).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('投递成功记录 queued 状态', async () => {
    vi.setSystemTime(7_000);
    const store = fakeStore([task({ id: 'ok', nextRunAt: 99_000 })]);
    const { scheduler } = build(store);
    await scheduler.runNow('ok');
    expect(store.updateRunState).toHaveBeenCalledTimes(1);
    expect(store.updateRunState).toHaveBeenCalledWith('ok', {
      lastRunAt: 7_000,
      lastStatus: 'queued',
      lastError: null,
    });
    expect(store.rows[0]!.lastStatus).toBe('queued');
  });

  it('投递失败记录错误状态与消息并重新抛出', async () => {
    vi.setSystemTime(7_000);
    const store = fakeStore([task({ id: 'bad', nextRunAt: 99_000 })]);
    const { scheduler } = build(store, async () => {
      throw new Error('queue down');
    });
    await expect(scheduler.runNow('bad')).rejects.toThrow('queue down');
    expect(store.updateRunState).toHaveBeenNthCalledWith(1, 'bad', {
      lastRunAt: 7_000,
      lastStatus: 'queued',
      lastError: null,
    });
    expect(store.updateRunState).toHaveBeenNthCalledWith(2, 'bad', {
      lastStatus: 'error',
      lastError: 'queue down',
    });
    expect(store.rows[0]!.lastStatus).toBe('error');
    expect(store.rows[0]!.lastError).toBe('queue down');
  });

  it('非 Error 的投递失败使用 String 转换', async () => {
    const store = fakeStore([task({ id: 'bad', nextRunAt: 99_000 })]);
    const { scheduler } = build(store, async () => {
      throw 'plain failure';
    });
    await expect(scheduler.runNow('bad')).rejects.toBe('plain failure');
    expect(store.rows[0]!.lastError).toBe('plain failure');
  });

  it('没有启用任务时不留下计时器', async () => {
    const store = fakeStore([
      task({ id: 'off', enabled: false, nextRunAt: null }),
      task({ id: 'null-next', enabled: true, nextRunAt: null }),
    ]);
    const { scheduler } = build(store);
    await scheduler.start();
    expect(vi.getTimerCount()).toBe(0);
    await scheduler.reschedule();
    expect(vi.getTimerCount()).toBe(0);
    scheduler.stop();
  });

  describe('生命周期 generation', () => {
    it('stop→start 后旧 wake 恢复时不得推进、执行或重排', async () => {
      const store = fakeStore([task({ id: 'a', nextRunAt: 1_000 })]);
      const { scheduler, execute } = build(store);
      await scheduler.start();
      const release = store.holdList();
      await vi.advanceTimersByTimeAsync(1_000);
      scheduler.stop();
      const restarting = scheduler.start();
      release();
      await restarting;

      expect(execute).not.toHaveBeenCalled();
      // 只有新一代 start 的扫描推进过一次；旧 wake 没有重复推进。
      expect(store.replaceNextRunAt).toHaveBeenCalledTimes(1);
      expect(store.replaceNextRunAt).toHaveBeenCalledWith('a', 11_000);
      expect(store.updateRunState).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    });
  });

  describe('Store 瞬时异常的退避重试', () => {
    beforeEach(() => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    const atMostOneTimer = () => expect(vi.getTimerCount()).toBeLessThanOrEqual(1);

    it('wake 的 list 首次失败后 1s 恢复并只执行一次', async () => {
      const store = fakeStore([task({ id: 'a', nextRunAt: 1_000 })]);
      const { scheduler, execute } = build(store);
      await scheduler.start();
      store.failLists(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(execute).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(execute).not.toHaveBeenCalled();
      atMostOneTimer();

      await vi.advanceTimersByTimeAsync(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    });

    it('replaceNextRunAt 首次失败后恢复：已持久化的任务不丢失、失败的任务不重复', async () => {
      const store = fakeStore([
        task({ id: 'a', nextRunAt: 1_000 }),
        task({ id: 'b', nextRunAt: 1_000 }),
      ]);
      const { scheduler, execute } = build(store);
      await scheduler.start();
      store.failReplace('a', 1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(execute.mock.calls.map(([t]) => t.id)).toEqual(['b']);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(execute.mock.calls.map(([t]) => t.id)).toEqual(['b', 'a']);
      atMostOneTimer();
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    });

    it('执行后末次扫描失败时重试，不会重复执行已触发的任务', async () => {
      const store = fakeStore([task({ id: 'a', nextRunAt: 1_000 })]);
      const { scheduler, execute } = build(store);
      await scheduler.start();
      store.failLists(false, true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    });

    it('退避从 1s 指数增长，上限 60s，成功扫描后重置', async () => {
      const store = fakeStore([task({ id: 'a', nextRunAt: 1_000 })]);
      const { scheduler, execute } = build(store);
      await scheduler.start();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      store.failLists(...Array<boolean>(8).fill(true));

      await vi.advanceTimersByTimeAsync(1_000);
      const backoff = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
      for (const delay of backoff) {
        atMostOneTimer();
        expect(setTimeoutSpy.mock.calls.at(-1)![1]).toBe(delay);
        expect(execute).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(delay);
      }
      expect(execute).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      // 恢复后再次失败应重新从 1s 开始。
      const nextDelay = setTimeoutSpy.mock.calls.at(-1)![1] as number;
      store.failLists(true);
      await vi.advanceTimersByTimeAsync(nextDelay);
      expect(setTimeoutSpy.mock.calls.at(-1)![1]).toBe(1_000);
      atMostOneTimer();
      scheduler.stop();
    });

    it('start 的首次 list 失败后 1s 恢复，且 start 不拒绝', async () => {
      const store = fakeStore([task({ id: 'a', nextRunAt: 3_000 })]);
      const { scheduler, execute } = build(store);
      store.failLists(true);

      await expect(scheduler.start()).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(1);
      const listCalls = store.list.mock.calls.length;

      await vi.advanceTimersByTimeAsync(999);
      expect(store.list.mock.calls.length).toBe(listCalls);
      atMostOneTimer();

      await vi.advanceTimersByTimeAsync(1);
      expect(store.list.mock.calls.length).toBeGreaterThan(listCalls);
      expect(execute).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    });

    it('start 的 replaceNextRunAt 失败后重试只推进过期任务，不补跑', async () => {
      vi.setSystemTime(35_000);
      const store = fakeStore([task({ id: 'stale', nextRunAt: 1_000 })]);
      const { scheduler, execute } = build(store);
      store.failReplace('stale', 1);

      await expect(scheduler.start()).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(execute).not.toHaveBeenCalled();
      expect(store.rows[0]!.nextRunAt).toBe(41_000);
      expect(store.updateRunState).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(execute).toHaveBeenCalledTimes(1);
      scheduler.stop();
    });

    it('reschedule 的首次 list 失败后 1s 恢复，且 reschedule 不拒绝', async () => {
      const store = fakeStore([task({ id: 'far', nextRunAt: 10_000 })]);
      const { scheduler, execute } = build(store);
      await scheduler.start();
      store.add(task({ id: 'near', nextRunAt: 5_000 }));
      store.failLists(true);

      await expect(scheduler.reschedule()).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(999);
      atMostOneTimer();
      expect(execute).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(execute.mock.calls.map(([t]) => t.id)).toEqual(['near']);
      atMostOneTimer();
      scheduler.stop();
    });

    it('stop 之后失败的 reschedule 不安排重试且不拒绝', async () => {
      const store = fakeStore([task({ id: 'a', nextRunAt: 5_000 })]);
      const { scheduler } = build(store);
      await scheduler.start();
      const release = store.holdList();
      const rescheduling = scheduler.reschedule();
      await vi.advanceTimersByTimeAsync(0);
      scheduler.stop();
      release.reject(new Error('stale list failure'));
      await expect(rescheduling).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stop 取消重试计时器', async () => {
      const store = fakeStore([task({ id: 'a', nextRunAt: 1_000 })]);
      const { scheduler, execute } = build(store);
      await scheduler.start();
      store.failLists(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(vi.getTimerCount()).toBe(1);

      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
      const listCalls = store.list.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.list.mock.calls.length).toBe(listCalls);
      expect(execute).not.toHaveBeenCalled();
    });

    it('generation 过期的旧 wake 失败时不安排重试', async () => {
      const store = fakeStore([task({ id: 'a', nextRunAt: 1_000 })]);
      const { scheduler, execute } = build(store);
      await scheduler.start();
      const release = store.holdList();
      await vi.advanceTimersByTimeAsync(1_000);
      scheduler.stop();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const restarting = scheduler.start();
      release.reject(new Error('stale list failure'));
      await restarting;

      // 新一代 start 把 a 推进到 11_000，应只安排 10s 的计时器；不应出现旧代的 1s 重试。
      expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toEqual([10_000]);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(execute).not.toHaveBeenCalled();
      scheduler.stop();
    });
  });
});
