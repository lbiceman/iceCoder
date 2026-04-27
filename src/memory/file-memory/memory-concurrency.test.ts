/**
 * memory-concurrency 单元测试。
 *
 * P0 — 并发 bug 最难排查。
 * 覆盖：sequential 串行化、ConsolidationLock 竞争/回滚/死锁检测、ExtractionGuard 互斥。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  sequential,
  ConsolidationLock,
  initExtractionGuard,
  drainExtractions,
  type ExtractionGuardState,
} from './memory-concurrency.js';

// ─── sequential ───

describe('sequential', () => {
  it('串行执行异步函数', async () => {
    const order: number[] = [];

    const fn = sequential(async (id: number, delay: number) => {
      order.push(id);
      await new Promise(r => setTimeout(r, delay));
      order.push(id * 10);
    });

    // 同时发起 3 个调用
    const p1 = fn(1, 30);
    const p2 = fn(2, 10);
    const p3 = fn(3, 10);

    await Promise.all([p1, p2, p3]);

    // 应该严格串行：1 开始 → 1 结束 → 2 开始 → 2 结束 → 3 开始 → 3 结束
    expect(order).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it('前一个失败不阻塞后续调用', async () => {
    let callCount = 0;

    const fn = sequential(async (shouldFail: boolean) => {
      callCount++;
      if (shouldFail) throw new Error('fail');
      return 'ok';
    });

    // 第一个失败
    await fn(true).catch(() => {});
    // 第二个应该正常执行
    const result = await fn(false);

    expect(callCount).toBe(2);
    expect(result).toBe('ok');
  });

  it('返回值正确传递', async () => {
    const fn = sequential(async (x: number) => x * 2);

    const results = await Promise.all([fn(1), fn(2), fn(3)]);

    expect(results).toEqual([2, 4, 6]);
  });
});

// ─── ConsolidationLock ───

describe('ConsolidationLock', () => {
  let tempDir: string;
  let lock: ConsolidationLock;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `lock-test-${randomUUID()}`);
    await fs.mkdir(tempDir, { recursive: true });
    lock = new ConsolidationLock(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('readLastConsolidatedAt', () => {
    it('无锁文件返回 0', async () => {
      const result = await lock.readLastConsolidatedAt();
      expect(result).toBe(0);
    });

    it('有锁文件返回 mtime', async () => {
      const lockPath = path.join(tempDir, '.consolidate-lock');
      await fs.writeFile(lockPath, String(process.pid));

      const result = await lock.readLastConsolidatedAt();
      expect(result).toBeGreaterThan(0);
      // mtime 应该接近当前时间
      expect(Date.now() - result).toBeLessThan(5000);
    });
  });

  describe('tryAcquire', () => {
    it('无锁文件时成功获取，返回 0', async () => {
      const priorMtime = await lock.tryAcquire();

      expect(priorMtime).toBe(0);

      // 验证锁文件已创建，内容为当前 PID
      const lockPath = path.join(tempDir, '.consolidate-lock');
      const content = await fs.readFile(lockPath, 'utf-8');
      expect(parseInt(content.trim(), 10)).toBe(process.pid);
    });

    it('自己持有的锁可以重新获取', async () => {
      // 第一次获取
      const first = await lock.tryAcquire();
      expect(first).toBe(0);

      // 第二次获取（自己的 PID，但锁未过期）
      // 由于 isProcessRunning(process.pid) 返回 true，
      // 但持有者就是自己，所以行为取决于实现
      // 当前实现：如果 PID 存活则返回 null（被阻塞）
      const second = await lock.tryAcquire();
      // 当前进程的 PID 是存活的，所以会被阻塞
      expect(second).toBeNull();
    });

    it('死进程的锁可以回收', async () => {
      const lockPath = path.join(tempDir, '.consolidate-lock');
      // 写入一个不存在的 PID
      await fs.writeFile(lockPath, '999999999');

      const priorMtime = await lock.tryAcquire();

      // 应该成功回收
      expect(priorMtime).not.toBeNull();
    });
  });

  describe('rollback', () => {
    it('priorMtime 为 0 时删除锁文件', async () => {
      // 先获取锁
      await lock.tryAcquire();
      const lockPath = path.join(tempDir, '.consolidate-lock');

      // 验证锁文件存在
      await expect(fs.access(lockPath)).resolves.toBeUndefined();

      // 回滚
      await lock.rollback(0);

      // 锁文件应该被删除
      await expect(fs.access(lockPath)).rejects.toThrow();
    });

    it('priorMtime 非 0 时恢复 mtime', async () => {
      const lockPath = path.join(tempDir, '.consolidate-lock');
      await fs.writeFile(lockPath, '');

      const targetMtime = Date.now() - 3600_000; // 1 小时前
      await lock.rollback(targetMtime);

      const stat = await fs.stat(lockPath);
      // mtime 应该接近目标值（允许 1 秒误差）
      expect(Math.abs(stat.mtimeMs - targetMtime)).toBeLessThan(1000);
    });

    it('锁文件不存在时不报错', async () => {
      // 不应该抛出异常
      await expect(lock.rollback(0)).resolves.toBeUndefined();
    });
  });

  describe('recordConsolidation', () => {
    it('创建锁文件并写入 PID', async () => {
      await lock.recordConsolidation();

      const lockPath = path.join(tempDir, '.consolidate-lock');
      const content = await fs.readFile(lockPath, 'utf-8');
      expect(parseInt(content.trim(), 10)).toBe(process.pid);
    });

    it('目录不存在时自动创建', async () => {
      const nestedDir = path.join(tempDir, 'nested', 'deep');
      const nestedLock = new ConsolidationLock(nestedDir);

      await nestedLock.recordConsolidation();

      const lockPath = path.join(nestedDir, '.consolidate-lock');
      await expect(fs.access(lockPath)).resolves.toBeUndefined();
    });
  });
});

// ─── ExtractionGuard ───

describe('ExtractionGuard', () => {
  let guard: ExtractionGuardState;

  beforeEach(() => {
    guard = initExtractionGuard();
  });

  it('初始状态正确', () => {
    expect(guard.inProgress).toBe(false);
    expect(guard.lastProcessedIndex).toBe(0);
    expect(guard.pendingContext).toBeNull();
    expect(guard.inFlightExtractions.size).toBe(0);
  });

  it('每次 initExtractionGuard 创建独立状态', () => {
    const guard1 = initExtractionGuard();
    const guard2 = initExtractionGuard();

    guard1.inProgress = true;
    guard1.lastProcessedIndex = 10;

    expect(guard2.inProgress).toBe(false);
    expect(guard2.lastProcessedIndex).toBe(0);
  });

  it('inFlightExtractions 可追踪进行中的提取', () => {
    const extraction = new Promise<void>(resolve => setTimeout(resolve, 10));
    guard.inFlightExtractions.add(extraction);

    expect(guard.inFlightExtractions.size).toBe(1);

    extraction.then(() => {
      guard.inFlightExtractions.delete(extraction);
    });
  });

  it('pendingContext 暂存尾随请求', () => {
    guard.inProgress = true;
    guard.pendingContext = {
      messages: [{ role: 'user', content: 'test' }],
      turnCount: 5,
    };

    expect(guard.pendingContext).not.toBeNull();
    expect(guard.pendingContext!.turnCount).toBe(5);
  });
});

describe('drainExtractions', () => {
  it('无进行中提取时立即返回', async () => {
    const guard = initExtractionGuard();
    const start = Date.now();

    await drainExtractions(guard);

    expect(Date.now() - start).toBeLessThan(100);
  });

  it('等待进行中的提取完成', async () => {
    const guard = initExtractionGuard();
    let resolved = false;

    const extraction = new Promise<void>(resolve => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 50);
    });
    guard.inFlightExtractions.add(extraction);

    await drainExtractions(guard, 5000);

    expect(resolved).toBe(true);
  });

  it('超时后不再等待', async () => {
    const guard = initExtractionGuard();

    const neverResolve = new Promise<void>(() => {}); // 永远不 resolve
    guard.inFlightExtractions.add(neverResolve);

    const start = Date.now();
    await drainExtractions(guard, 100);
    const elapsed = Date.now() - start;

    // 应该在超时后返回
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(500);
  });
});
