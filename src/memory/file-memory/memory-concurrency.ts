/**
 * 记忆系统并发控制与锁机制。
 *
 * 提供：
 * 1. sequential() — 将异步函数包装为串行执行（防止重叠运行）
 * 2. ConsolidationLock — 基于文件的 autoDream 整合锁
 *    - 锁文件的 mtime 即 lastConsolidatedAt
 *    - PID 写入锁文件体，用于死锁检测
 *    - 支持回滚（失败时恢复 mtime）
 * 3. ExtractionGuard — 提取互斥守卫（闭包隔离）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

// ─── sequential 包装器 ───

/**
 * 将异步函数包装为串行执行。
 * 如果上一次调用尚未完成，新调用会排队等待。
 * 用于防止 extractMemories / autoDream 重叠运行。
 */
export function sequential<T extends (...args: any[]) => Promise<any>>(fn: T): T {
  let pending: Promise<any> = Promise.resolve();

  const wrapped = ((...args: any[]) => {
    const run = () => fn(...args);
    pending = pending.then(run, run);
    return pending;
  }) as T;

  return wrapped;
}

// ─── ConsolidationLock ───

const LOCK_FILE = '.consolidate-lock';
const HOLDER_STALE_MS = 60 * 60 * 1000; // 1 小时

/**
 * 基于文件的 autoDream 整合锁。
 *
 * 锁文件位于记忆目录内，mtime 即 lastConsolidatedAt。
 * 文件体写入持有者的 PID，用于死锁检测。
 *
 * 使用流程：
 * 1. readLastConsolidatedAt() — 读取上次整合时间（一次 stat）
 * 2. tryAcquire() — 尝试获取锁，返回 priorMtime 或 null
 * 3. 成功 → 执行整合 → mtime 自动更新为 now
 * 4. 失败 → rollback(priorMtime) 恢复 mtime
 */
export class ConsolidationLock {
  private lockPath: string;

  constructor(memoryDir: string) {
    this.lockPath = path.join(memoryDir, LOCK_FILE);
  }

  /**
   * 读取上次整合时间。锁文件不存在返回 0。
   * 每轮成本：一次 stat。
   */
  async readLastConsolidatedAt(): Promise<number> {
    try {
      const s = await fs.stat(this.lockPath);
      return s.mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * 尝试获取锁。
   *
   * 成功返回 priorMtime（用于回滚），失败返回 null。
   * 死锁检测：如果持有者 PID 已死，强制回收。
   */
  async tryAcquire(): Promise<number | null> {
    let mtimeMs: number | undefined;
    let holderPid: number | undefined;

    try {
      const [s, raw] = await Promise.all([
        fs.stat(this.lockPath),
        fs.readFile(this.lockPath, 'utf-8'),
      ]);
      mtimeMs = s.mtimeMs;
      const parsed = parseInt(raw.trim(), 10);
      holderPid = Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      // ENOENT — 无锁文件
    }

    // 锁未过期且持有者存活 → 获取失败
    if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
      if (holderPid !== undefined && this.isProcessRunning(holderPid)) {
        console.debug(
          `[ConsolidationLock] held by live PID ${holderPid} (${Math.round((Date.now() - mtimeMs) / 1000)}s ago)`,
        );
        return null;
      }
      // 死 PID 或无法解析 → 回收
    }

    // 写入当前 PID
    const dir = path.dirname(this.lockPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.lockPath, String(process.pid));

    // 竞争检测：两个进程同时写入，后写者赢
    let verify: string;
    try {
      verify = await fs.readFile(this.lockPath, 'utf-8');
    } catch {
      return null;
    }
    if (parseInt(verify.trim(), 10) !== process.pid) return null;

    return mtimeMs ?? 0;
  }

  /**
   * 回滚锁：恢复 mtime 到获取前的值。
   * priorMtime === 0 → 删除锁文件。
   */
  async rollback(priorMtime: number): Promise<void> {
    try {
      if (priorMtime === 0) {
        await fs.unlink(this.lockPath);
        return;
      }
      await fs.writeFile(this.lockPath, '');
      const t = priorMtime / 1000; // utimes 接受秒
      await fs.utimes(this.lockPath, t, t);
    } catch (e) {
      console.debug(
        `[ConsolidationLock] rollback failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * 手动标记整合完成（更新 mtime 为 now）。
   */
  async recordConsolidation(): Promise<void> {
    try {
      const dir = path.dirname(this.lockPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.lockPath, String(process.pid));
    } catch (e) {
      console.debug(
        `[ConsolidationLock] recordConsolidation failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * 检查进程是否存活。
   */
  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── ExtractionGuard ───

/**
 * 提取互斥守卫。
 *
 * 闭包隔离模式：每次 initExtractionGuard() 创建独立的状态闭包，
 * 测试中在 beforeEach 调用即可获得干净状态。
 *
 * 功能：
 * - inProgress 互斥：防止重叠提取
 * - trailing run：提取进行中收到新请求时，暂存最新上下文，
 *   当前提取完成后自动执行一次尾随提取
 * - cursor 追踪：记录上次处理到的消息位置
 */
export interface ExtractionGuardState {
  /** 是否正在提取 */
  inProgress: boolean;
  /** 上次处理到的消息索引 */
  lastProcessedIndex: number;
  /** 暂存的尾随请求上下文 */
  pendingContext: { messages: any[]; turnCount: number } | null;
  /** 进行中的 Promise 集合（用于 drain） */
  inFlightExtractions: Set<Promise<void>>;
}

/**
 * 创建提取互斥守卫（闭包隔离）。
 */
export function initExtractionGuard(): ExtractionGuardState {
  return {
    inProgress: false,
    lastProcessedIndex: 0,
    pendingContext: null,
    inFlightExtractions: new Set(),
  };
}

/**
 * 等待所有进行中的提取完成（带超时）。
 * 用于进程退出前确保提取完成。
 */
export async function drainExtractions(
  guard: ExtractionGuardState,
  timeoutMs: number = 60_000,
): Promise<void> {
  if (guard.inFlightExtractions.size === 0) return;
  await Promise.race([
    Promise.all(guard.inFlightExtractions).catch(() => {}),
    new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
  ]);
}
