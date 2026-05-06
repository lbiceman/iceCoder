/**
 * 后台任务管理器。
 *
 * 管理后台运行的 shell 进程，支持：
 * - 启动后台命令（立即返回 task ID）
 * - 查询任务状态和输出
 * - 终止任务
 * - 超时自动终止
 * - 完成后自动清理
 *
 * 设计为进程级单例，所有工具共享同一个实例。
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/** 任务状态 */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'timeout' | 'killed';

/** 后台任务信息 */
export interface BackgroundTask {
  taskId: string;
  command: string;
  label: string;
  status: TaskStatus;
  child: ChildProcess | null;
  /** 环形缓冲区：最近的输出行 */
  outputLines: string[];
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  error: string | null;
}

/** 任务状态摘要（返回给调用方，不含 child 引用） */
export interface TaskStatusSummary {
  taskId: string;
  command: string;
  label: string;
  status: TaskStatus;
  elapsed: string;
  exitCode: number | null;
  error: string | null;
  lineCount: number;
}

/** 最大输出行数（环形缓冲区） */
const MAX_OUTPUT_LINES = 500;

/** 最大并发任务数 */
const MAX_CONCURRENT = 8;

/** 完成后自动清理延迟（毫秒） */
const AUTO_CLEANUP_DELAY = 30 * 60 * 1000; // 30 分钟

/** 危险命令黑名单（复用 shell-tool 的规则） */
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\/(?!\w)/i,
  /\bformat\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b:>\s*\/etc\//i,
  /\bshutdown\b/i,
  /\breboot\b/i,
];

/** 生成短 ID */
function generateId(): string {
  return 'bg_' + Math.random().toString(36).substring(2, 8);
}

/** 格式化耗时 */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}m${remainSeconds}s`;
}

/**
 * 后台任务管理器。
 */
export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private workDir: string;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  /**
   * 启动后台命令。
   * 立即返回 task ID，不等待命令完成。
   */
  spawn(command: string, timeoutMs: number = 300_000, label: string = ''): {
    taskId: string;
    error?: string;
  } {
    // 安全检查
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { taskId: '', error: '安全检查失败: 命令包含危险操作模式' };
      }
    }

    // 并发检查
    const runningCount = Array.from(this.tasks.values())
      .filter(t => t.status === 'running').length;
    if (runningCount >= MAX_CONCURRENT) {
      return {
        taskId: '',
        error: `后台任务数已达上限 (${MAX_CONCURRENT})，请等待其他任务完成`,
      };
    }

    const taskId = generateId();
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows ? ['/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd: this.workDir,
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const task: BackgroundTask = {
      taskId,
      command,
      label: label || command.substring(0, 50),
      status: 'running',
      child,
      outputLines: [],
      startTime: Date.now(),
      endTime: null,
      exitCode: null,
      error: null,
    };

    this.tasks.set(taskId, task);

    // 收集输出（环形缓冲区）
    const appendOutput = (data: Buffer, prefix: string = '') => {
      const lines = (prefix + data.toString()).split('\n');
      for (const line of lines) {
        if (line.length === 0 && task.outputLines.length > 0) continue;
        task.outputLines.push(line);
        // 环形缓冲区：超出时从头部丢弃
        if (task.outputLines.length > MAX_OUTPUT_LINES) {
          task.outputLines.splice(0, task.outputLines.length - MAX_OUTPUT_LINES);
        }
      }
    };

    child.stdout?.on('data', (data: Buffer) => appendOutput(data));
    child.stderr?.on('data', (data: Buffer) => appendOutput(data, '[stderr] '));

    // 进程结束
    child.on('close', (code) => {
      if (task.status === 'running') {
        task.status = code === 0 ? 'completed' : 'failed';
        task.exitCode = code;
        task.endTime = Date.now();
        task.child = null;
        this.scheduleCleanup(taskId);
      }
    });

    child.on('error', (err) => {
      if (task.status === 'running') {
        task.status = 'failed';
        task.error = `进程启动失败: ${err.message}`;
        task.endTime = Date.now();
        task.child = null;
        this.scheduleCleanup(taskId);
      }
    });

    // 超时处理
    setTimeout(() => {
      if (task.status === 'running') {
        task.status = 'timeout';
        task.error = `执行超时 (${formatElapsed(timeoutMs)})`;
        task.endTime = Date.now();
        // 尝试优雅终止
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => {
          if (task.child) {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }
          task.child = null;
          this.scheduleCleanup(taskId);
        }, 2000);
      }
    }, timeoutMs);

    return { taskId };
  }

  /**
   * 获取任务状态摘要。
   */
  getStatus(taskId: string): TaskStatusSummary | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const elapsed = task.endTime
      ? task.endTime - task.startTime
      : Date.now() - task.startTime;

    return {
      taskId: task.taskId,
      command: task.command,
      label: task.label,
      status: task.status,
      elapsed: formatElapsed(elapsed),
      exitCode: task.exitCode,
      error: task.error,
      lineCount: task.outputLines.length,
    };
  }

  /**
   * 获取任务输出（最近 N 行）。
   */
  getOutput(taskId: string, tail: number = 50): string | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const lines = task.outputLines.slice(-tail);
    return lines.join('\n');
  }

  /**
   * 终止任务。
   */
  kill(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;

    task.status = 'killed';
    task.endTime = Date.now();
    task.error = '被用户终止';
    try { task.child?.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { task.child?.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
    task.child = null;
    this.scheduleCleanup(taskId);
    return true;
  }

  /**
   * 列出所有任务。
   */
  list(): TaskStatusSummary[] {
    const result: TaskStatusSummary[] = [];
    for (const task of this.tasks.values()) {
      result.push(this.getStatus(task.taskId)!);
    }
    return result.sort((a, b) => {
      // 运行中的排前面
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return 0;
    });
  }

  /**
   * 清理所有资源（优雅关闭时调用）。
   */
  dispose(): void {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') {
        try { task.child?.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.tasks.clear();
    this.cleanupTimers.clear();
  }

  /**
   * 调度自动清理（完成后 30 分钟删除任务记录）。
   */
  private scheduleCleanup(taskId: string): void {
    const timer = setTimeout(() => {
      this.tasks.delete(taskId);
      this.cleanupTimers.delete(taskId);
    }, AUTO_CLEANUP_DELAY);
    this.cleanupTimers.set(taskId, timer);
  }
}

/**
 * 全局单例（进程级）。
 */
let globalManager: BackgroundTaskManager | null = null;

export function getBackgroundTaskManager(workDir?: string): BackgroundTaskManager {
  if (!globalManager) {
    globalManager = new BackgroundTaskManager(workDir || process.cwd());
  }
  return globalManager;
}
