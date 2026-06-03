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

import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  analyzeShellHostSafety,
  buildShellChildEnv,
  matchesDangerousShellPattern,
} from './shell-host-guard.js';

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
  /** 任务期间累计输出行数（含被环形缓冲淘汰的） */
  totalOutputLines: number;
  /** 最近一次有 stdout/stderr 数据到达的时刻（hang 检测用） */
  lastOutputAt: number;
  /** Harness 摘要注入：上次发出摘要的时刻；0 表示从未发出 */
  lastSummaryEmittedAt: number;
  /** 状态变更后置 true，下一次摘要查询必返回该任务 */
  summaryDirty: boolean;
  /** 落盘日志写流；null 表示未启用落盘 */
  logStream: WriteStream | null;
  /** 落盘日志路径（绝对路径） */
  logPath: string | null;
  /** spawn 时的根 PID（Windows 进程树 kill 用；child 句柄失效时仍可杀） */
  rootPid: number | null;
  /** 从输出中解析到的 dev server 监听端口（Windows 兜底 kill） */
  detectedPort: number | null;
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

/** 运行中任务摘要（给 Harness / chat-ws 推送用） */
export interface RunningTaskSummary {
  taskId: string;
  command: string;
  label: string;
  status: TaskStatus;
  elapsedMs: number;
  elapsed: string;
  /** 距上次摘要新增的输出行数 */
  newLinesSinceLastSummary: number;
  /** 任务总输出行数 */
  totalOutputLines: number;
  /** 最近一次有输出的时刻 → 用于 hang 检测 */
  lastOutputAt: number;
  /** exit code（仅终态） */
  exitCode: number | null;
  /** 错误信息（仅 failed/timeout/killed） */
  error: string | null;
  /** 终态标记 */
  isTerminal: boolean;
}

/** 增量输出查询结果 */
export interface OutputSinceResult {
  /** 新增行（含 prefix，不含环形缓冲外的早期内容） */
  output: string;
  /** 下次应传入的 cursor（即当前 totalOutputLines） */
  cursor: number;
  /** 是否有缓冲被丢弃（since 早于当前缓冲起点） */
  truncated: boolean;
}

/** 最大输出行数（环形缓冲区） */
const MAX_OUTPUT_LINES = 500;

/** 最大并发任务数 */
const MAX_CONCURRENT = 8;

/** 完成后自动清理延迟（毫秒） */
const AUTO_CLEANUP_DELAY = 30 * 60 * 1000; // 30 分钟

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

/** 从 dev server 输出中解析监听端口（Vite / webpack-dev-server 等） */
function detectListenPort(text: string): number | null {
  const patterns = [
    /Local:\s*(?:https?:\/\/)?(?:[\w.]+:)?(\d{2,5})/i,
    /localhost:(\d{2,5})/i,
    /127\.0\.0\.1:(\d{2,5})/i,
    /:\s*(\d{4,5})\s*(?:\n|$)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const port = parseInt(m[1], 10);
      if (port > 0 && port < 65536) return port;
    }
  }
  return null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as NodeJS.ErrnoException).code : '';
    return code !== 'ESRCH';
  }
}

/** Windows：递归终止进程树（taskkill + PowerShell 子进程扫描） */
function killWindowsProcessTree(rootPid: number): void {
  try {
    execFileSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'pipe',
    });
    console.log(`[bg-task] taskkill /T /F 成功 pid=${rootPid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bg-task] taskkill 失败 pid=${rootPid}: ${msg}`);
  }
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$root=${rootPid};$seen=@{};$q=[Collections.Queue]::new();$q.Enqueue($root);`
          + 'while($q.Count -gt 0){$p=$q.Dequeue();if($seen[$p]){continue};$seen[$p]=$true;'
          + 'Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | ForEach-Object {$q.Enqueue([int]$_.ProcessId)}};'
          + 'foreach($p in $seen.Keys){try{Stop-Process -Id $p -Force -ErrorAction SilentlyContinue}catch{}}',
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    console.log(`[bg-task] PowerShell 进程树 kill 完成 rootPid=${rootPid}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bg-task] PowerShell 进程树 kill 失败 rootPid=${rootPid}: ${msg}`);
  }
}

/** Windows：按监听端口终止 dev server（pnpm/vite 脱离 cmd 进程树时的兜底） */
function killProcessesOnPortWindows(port: number): void {
  try {
    execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=${port};Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue `
          + '| Select-Object -ExpandProperty OwningProcess -Unique '
          + '| ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }',
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    console.log(`[bg-task] 已按端口 ${port} 终止监听进程`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[bg-task] 按端口 ${port} 终止失败: ${msg}`);
  }
}

/**
 * 后台任务管理器。
 *
 * 自 Phase 3 起，每个 sessionId 一个独立实例（通过 {@link getBackgroundTaskManagerFor} 工厂）。
 *
 * 事件（EventEmitter）：
 * - `taskStatusChanged` — 任务状态从 running 切到任意终态时触发，载荷为 {@link RunningTaskSummary}
 * - `taskOutput` — 任务有新输出时触发（细粒度；性能敏感场景慎用）
 */
export class BackgroundTaskManager extends EventEmitter {
  private tasks = new Map<string, BackgroundTask>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private workDir: string;
  readonly sessionId: string;
  /** 后台日志根目录；默认 `<workDir>/data/sessions/<sid>/bg` */
  private readonly logDir: string;

  constructor(workDir: string, sessionId: string = 'default', logDir?: string) {
    super();
    this.workDir = path.resolve(workDir);
    this.sessionId = sessionId;
    this.logDir = logDir ?? path.join(this.workDir, 'data', 'sessions', sessionId, 'bg');
  }

  /** 当前命令执行 cwd（spawn 使用；logDir 在构造时固定，不随 cwd 变更） */
  getWorkDir(): string {
    return this.workDir;
  }

  /** workspace 切换时更新 spawn cwd，保留同 session 的任务列表与 logDir */
  setWorkDir(workDir: string): void {
    this.workDir = path.resolve(workDir);
  }

  /**
   * 创建任务的落盘日志写流。失败不抛 — 任务仍可运行，只是不落盘。
   */
  private openLogStream(taskId: string): { stream: WriteStream | null; logPath: string | null } {
    try {
      mkdirSync(this.logDir, { recursive: true });
      const logPath = path.join(this.logDir, `${taskId}.log`);
      const stream = createWriteStream(logPath, { flags: 'a', encoding: 'utf-8' });
      stream.on('error', () => { /* swallow — 日志失败不阻塞任务 */ });
      return { stream, logPath };
    } catch {
      return { stream: null, logPath: null };
    }
  }

  /**
   * 标记任务状态变更：清零摘要节流以便下一次必发，且 emit 'taskStatusChanged'。
   */
  markSummaryDirty(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.summaryDirty = true;
    this.emit('taskStatusChanged', this.buildRunningSummary(task));
  }

  /**
   * 跨平台进程树 kill（POSIX）。
   *
   * Windows 请用 {@link killTaskProcesses}。
   */
  private killTreePosix(child: ChildProcess): void {
    if (!child.pid) return;
    const pid = child.pid;
    try { process.kill(-pid, 'SIGTERM'); } catch {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }
    setTimeout(() => {
      if (!child.pid) return;
      try { process.kill(-pid, 'SIGKILL'); } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 2000);
    console.log(`[bg-task] 已发送 SIGTERM 至进程组 pid=${pid}`);
  }

  /** 终止任务关联的全部 OS 进程（含 Windows 端口兜底） */
  private killTaskProcesses(task: BackgroundTask): void {
    const rootPid = task.rootPid ?? task.child?.pid ?? null;
    if (process.platform === 'win32') {
      if (rootPid) {
        killWindowsProcessTree(rootPid);
        if (isPidAlive(rootPid)) {
          console.warn(`[bg-task] rootPid=${rootPid} 仍存活，尝试按端口兜底`);
        }
      } else {
        console.warn(`[bg-task] kill ${task.taskId}: 无 rootPid，无法杀 OS 进程`);
      }
      if (task.detectedPort) {
        killProcessesOnPortWindows(task.detectedPort);
      }
      return;
    }
    if (task.child) {
      this.killTreePosix(task.child);
    }
  }

  /**
   * 把一个已经 spawn 的前台 ChildProcess 转交为后台任务。
   *
   * Phase 2 软超时 escalate 专用：当前台命令 8s 后仍在跑，
   * shell-tool 调此方法把 child 引用 + 已收集的输出转给 manager 继续接管。
   *
   * @param child  已 spawn 的子进程引用
   * @param options.command       原始命令字符串
   * @param options.label         任务标签（命令前 40 字）
   * @param options.prefixOutput  前台已收集的 stdout/stderr（作为环形缓冲 prefix）
   * @param options.hardTimeoutMs 后台 hard timeout（默认 24h）
   * @param options.reason        转后台原因（'soft_timeout' / 'explicit_background'）
   */
  adopt(
    child: ChildProcess,
    options: {
      command: string;
      label?: string;
      prefixOutput?: string;
      hardTimeoutMs?: number;
      reason?: 'soft_timeout' | 'explicit_background';
    },
  ): { taskId: string; error?: string } {
    const runningCount = Array.from(this.tasks.values())
      .filter(t => t.status === 'running').length;
    if (runningCount >= MAX_CONCURRENT) {
      return {
        taskId: '',
        error: `后台任务数已达上限 (${MAX_CONCURRENT})，请等待其他任务完成`,
      };
    }

    const taskId = generateId();
    const command = options.command;
    const hardTimeoutMs = options.hardTimeoutMs ?? 24 * 60 * 60 * 1000;
    const now = Date.now();

    const { stream: logStream, logPath } = this.openLogStream(taskId);
    const task: BackgroundTask = {
      taskId,
      command,
      label: options.label || command.substring(0, 50),
      status: 'running',
      child,
      outputLines: [],
      startTime: now,
      endTime: null,
      exitCode: null,
      error: null,
      totalOutputLines: 0,
      lastOutputAt: now,
      lastSummaryEmittedAt: 0,
      summaryDirty: false,
      logStream,
      logPath,
      rootPid: child.pid ?? null,
      detectedPort: null,
    };

    // 把前台已收集的输出灌入环形缓冲 + 落盘（不丢历史）
    if (options.prefixOutput) {
      this.appendOutput(task, Buffer.from(options.prefixOutput), '');
    }

    this.tasks.set(taskId, task);

    child.stdout?.on('data', (data: Buffer) => this.appendOutput(task, data, ''));
    child.stderr?.on('data', (data: Buffer) => this.appendOutput(task, data, '[stderr] '));

    // 接管进程退出
    child.on('close', (code) => {
      if (task.status === 'running') {
        task.status = code === 0 ? 'completed' : 'failed';
        task.exitCode = code;
        task.endTime = Date.now();
        task.child = null;
        this.closeLogStream(task);
        this.markSummaryDirty(taskId);
        this.scheduleCleanup(taskId);
      }
    });

    child.on('error', (err) => {
      if (task.status === 'running') {
        task.status = 'failed';
        task.error = `进程启动失败: ${err.message}`;
        task.endTime = Date.now();
        task.child = null;
        this.closeLogStream(task);
        this.markSummaryDirty(taskId);
        this.scheduleCleanup(taskId);
      }
    });

    // 接管 hard timeout（进程树 kill）
    setTimeout(() => {
      if (task.status === 'running') {
        task.status = 'timeout';
        task.error = `执行超时 (${formatElapsed(hardTimeoutMs)})`;
        task.endTime = Date.now();
        this.killTaskProcesses(task);
        this.closeLogStream(task);
        this.markSummaryDirty(taskId);
        setTimeout(() => {
          task.child = null;
          this.scheduleCleanup(taskId);
        }, 2500);
      }
    }, hardTimeoutMs);

    return { taskId };
  }

  /**
   * 启动后台命令。
   * 立即返回 task ID，不等待命令完成。
   */
  spawn(command: string, timeoutMs: number = 300_000, label: string = ''): {
    taskId: string;
    error?: string;
  } {
    const hostGuard = analyzeShellHostSafety(command, { workDir: this.workDir });
    if (hostGuard.blocked) {
      return { taskId: '', error: hostGuard.message ?? '[HostGuard / Blocked]' };
    }
    if (matchesDangerousShellPattern(command)) {
      return { taskId: '', error: '安全检查失败: 命令包含危险操作模式' };
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
      env: buildShellChildEnv(this.sessionId),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWindows,   // POSIX 进程组首，便于 killTree
      windowsHide: true,
    });

    const now = Date.now();
    const { stream: logStream, logPath } = this.openLogStream(taskId);
    const task: BackgroundTask = {
      taskId,
      command,
      label: label || command.substring(0, 50),
      status: 'running',
      child,
      outputLines: [],
      startTime: now,
      endTime: null,
      exitCode: null,
      error: null,
      totalOutputLines: 0,
      lastOutputAt: now,
      lastSummaryEmittedAt: 0,
      summaryDirty: false,
      logStream,
      logPath,
      rootPid: child.pid ?? null,
      detectedPort: null,
    };

    this.tasks.set(taskId, task);
    this.markSummaryDirty(taskId);

    child.stdout?.on('data', (data: Buffer) => this.appendOutput(task, data, ''));
    child.stderr?.on('data', (data: Buffer) => this.appendOutput(task, data, '[stderr] '));

    // 进程结束
    child.on('close', (code) => {
      if (task.status === 'running') {
        task.status = code === 0 ? 'completed' : 'failed';
        task.exitCode = code;
        task.endTime = Date.now();
        task.child = null;
        this.closeLogStream(task);
        this.markSummaryDirty(taskId);
        this.scheduleCleanup(taskId);
      }
    });

    child.on('error', (err) => {
      if (task.status === 'running') {
        task.status = 'failed';
        task.error = `进程启动失败: ${err.message}`;
        task.endTime = Date.now();
        task.child = null;
        this.closeLogStream(task);
        this.markSummaryDirty(taskId);
        this.scheduleCleanup(taskId);
      }
    });

    // 超时处理（进程树 kill）
    setTimeout(() => {
      if (task.status === 'running') {
        task.status = 'timeout';
        task.error = `执行超时 (${formatElapsed(timeoutMs)})`;
        task.endTime = Date.now();
        this.killTaskProcesses(task);
        this.closeLogStream(task);
        this.markSummaryDirty(taskId);
        setTimeout(() => {
          task.child = null;
          this.scheduleCleanup(taskId);
        }, 2500);
      }
    }, timeoutMs);

    return { taskId };
  }

  /**
   * 收集输出到环形缓冲 + 落盘 + 更新计数与 lastOutputAt。
   *
   * 共享于 spawn() 与 adopt()。
   */
  private appendOutput(task: BackgroundTask, data: Buffer, prefix: string): void {
    const text = prefix + data.toString();
    task.lastOutputAt = Date.now();

    if (!task.detectedPort) {
      const port = detectListenPort(text);
      if (port) {
        task.detectedPort = port;
        console.log(`[bg-task] ${task.taskId} 检测到监听端口 ${port}`);
      }
    }

    // 落盘（同步追加）— 失败由 stream.error 自行处理
    if (task.logStream) {
      try { task.logStream.write(text); } catch { /* ignore */ }
    }

    const lines = text.split('\n');
    for (const line of lines) {
      if (line.length === 0 && task.outputLines.length > 0) continue;
      task.outputLines.push(line);
      task.totalOutputLines += 1;
      if (task.outputLines.length > MAX_OUTPUT_LINES) {
        task.outputLines.splice(0, task.outputLines.length - MAX_OUTPUT_LINES);
      }
    }
    this.emit('taskOutput', { taskId: task.taskId, newLines: lines.length });
  }

  /**
   * 关闭日志写流（任务终态时调用）。
   */
  private closeLogStream(task: BackgroundTask): void {
    if (task.logStream) {
      try { task.logStream.end(); } catch { /* ignore */ }
      task.logStream = null;
    }
  }

  /**
   * 构造单个任务的 RunningTaskSummary（不包含 newLinesSinceLastSummary 修正）。
   */
  private buildRunningSummary(task: BackgroundTask): RunningTaskSummary {
    const endTime = task.endTime ?? Date.now();
    const elapsedMs = endTime - task.startTime;
    const isTerminal = task.status !== 'running';
    return {
      taskId: task.taskId,
      command: task.command,
      label: task.label,
      status: task.status,
      elapsedMs,
      elapsed: formatElapsed(elapsedMs),
      newLinesSinceLastSummary: 0,  // 由 getRunningSummary 计算
      totalOutputLines: task.totalOutputLines,
      lastOutputAt: task.lastOutputAt,
      exitCode: task.exitCode,
      error: task.error,
      isTerminal,
    };
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
   * 获取任务的增量输出（自上次 cursor 起）。
   *
   * 学 Claude Code BashOutput 的 diff-only 模型：
   * - since 是上一次 check 返回的 cursor（即当时的 totalOutputLines）
   * - 返回新行 + 新 cursor
   * - 如果 since 早于当前环形缓冲起点 → truncated=true（淘汰部分丢失）
   *
   * @param taskId 任务 ID
   * @param since 上次返回的 cursor（首次传 0 或不传）
   */
  getOutputSince(taskId: string, since: number = 0): OutputSinceResult | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const totalLines = task.totalOutputLines;
    const bufferStart = totalLines - task.outputLines.length;  // 环形缓冲第一行的全局索引
    const sinceClamped = Math.max(0, Math.min(since, totalLines));
    const truncated = sinceClamped < bufferStart;
    const start = Math.max(0, sinceClamped - bufferStart);
    const newLines = task.outputLines.slice(start);
    return {
      output: newLines.join('\n'),
      cursor: totalLines,
      truncated,
    };
  }

  /**
   * 获取所有 running 任务的摘要（含 newLinesSinceLastSummary）。
   *
   * 给 Harness LLM 通路 / chat-ws UI 通路推送共用：
   * - 仅返回 status === 'running' 的任务
   * - newLinesSinceLastSummary 基于 `lastSummaryEmittedAt` 与已读 cursor 计算（这里简化为 totalOutputLines - lastEmittedTotal）
   *
   * **注意**：本方法不自动 mark emit；调用方拿到结果后应当显式调用 {@link markSummaryEmitted}。
   */
  getRunningSummary(options: { onlyDirtyOrDue?: boolean; intervalMs?: number } = {}): RunningTaskSummary[] {
    const now = Date.now();
    const onlyDirtyOrDue = options.onlyDirtyOrDue ?? false;
    const intervalMs = options.intervalMs ?? 0;

    const out: RunningTaskSummary[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      if (onlyDirtyOrDue) {
        const due = task.lastSummaryEmittedAt === 0
          || (now - task.lastSummaryEmittedAt) >= intervalMs;
        if (!task.summaryDirty && !due) continue;
      }
      const summary = this.buildRunningSummary(task);
      // newLinesSinceLastSummary
      summary.newLinesSinceLastSummary = Math.max(
        0,
        task.totalOutputLines - this.getLastEmittedTotal(task),
      );
      out.push(summary);
    }
    return out;
  }

  /**
   * 标记某些任务的摘要已被发出（更新 lastSummaryEmittedAt + 清 dirty + 记录 totalOutputLines 基线）。
   *
   * @param taskIds 要标记的任务 ID 列表（一般是 getRunningSummary 返回的 taskId 集合）
   */
  markSummaryEmitted(taskIds: string[]): void {
    const now = Date.now();
    for (const id of taskIds) {
      const task = this.tasks.get(id);
      if (!task) continue;
      task.lastSummaryEmittedAt = now;
      task.summaryDirty = false;
      this.lastEmittedTotalCache.set(id, task.totalOutputLines);
    }
  }

  private lastEmittedTotalCache = new Map<string, number>();

  private getLastEmittedTotal(task: BackgroundTask): number {
    return this.lastEmittedTotalCache.get(task.taskId) ?? 0;
  }

  /**
   * 格式化 running summary 为 [Background Task Status] 文本块。
   *
   * 学文档 §10.2：占用预算 ≤ 600 字，超过截断。
   * 返回 null 表示无 running 任务（不应注入）。
   */
  formatRunningSummaryBlock(options: { intervalMs?: number; maxChars?: number } = {}): string | null {
    const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
    const maxChars = options.maxChars ?? 600;
    const summaries = this.getRunningSummary({ onlyDirtyOrDue: true, intervalMs });
    if (summaries.length === 0) return null;

    const lines: string[] = ['[Background Task Status]'];
    let truncated = false;
    for (const s of summaries) {
      const truncatedCmd = s.label.length > 50 ? s.label.slice(0, 47) + '...' : s.label;
      const newLinesPart = s.newLinesSinceLastSummary > 0
        ? `, ${s.newLinesSinceLastSummary} new lines since last check`
        : ', no new output';
      lines.push(`- ${s.taskId} (${truncatedCmd}, elapsed ${s.elapsed}): ${s.status}${newLinesPart}`);
      const joined = lines.join('\n');
      if (joined.length > maxChars) {
        // 回退最后一行并加截断提示
        lines.pop();
        truncated = true;
        break;
      }
    }
    if (truncated) {
      lines.push(`... more tasks; use action:"list" to see all`);
    }
    lines.push('[/Background Task Status]');
    return lines.join('\n');
  }

  /**
   * 导出当前所有任务的快照（给 checkpoint 序列化用）。
   *
   * Phase 5：仅 metadata，不含 child / outputLines。
   * 仍 running 的任务在 resume 后变成 'stale'（见 {@link loadStaleSnapshot}）。
   */
  exportSnapshot(): Array<{
    taskId: string;
    command: string;
    label: string;
    status: TaskStatus;
    startedAt: number;
    endedAt: number | null;
    exitCode: number | null;
    error: string | null;
    totalOutputLines: number;
    logPath: string | null;
  }> {
    const out: ReturnType<BackgroundTaskManager['exportSnapshot']> = [];
    for (const task of this.tasks.values()) {
      out.push({
        taskId: task.taskId,
        command: task.command,
        label: task.label,
        status: task.status,
        startedAt: task.startTime,
        endedAt: task.endTime,
        exitCode: task.exitCode,
        error: task.error,
        totalOutputLines: task.totalOutputLines,
        logPath: task.logPath,
      });
    }
    return out;
  }

  /**
   * 从 checkpoint 快照恢复：把曾经 running 的任务标记为「stale」状态加入 task 表，
   * 仅供 LLM 知情，不接管真实子进程。
   *
   * 已 terminal 状态的快照原样保留。
   */
  loadStaleSnapshot(
    snapshots: Array<{
      taskId: string;
      command: string;
      label: string;
      status: TaskStatus;
      startedAt: number;
      endedAt: number | null;
      exitCode: number | null;
      error: string | null;
      totalOutputLines: number;
      logPath: string | null;
    }>,
  ): void {
    for (const s of snapshots) {
      if (this.tasks.has(s.taskId)) continue;
      const wasRunning = s.status === 'running';
      const task: BackgroundTask = {
        taskId: s.taskId,
        command: s.command,
        label: s.label,
        // 还在跑的任务在新进程里无法接管 → 标记为 failed（带 'stale' 错误前缀）
        status: wasRunning ? 'failed' : s.status,
        child: null,
        outputLines: [],
        startTime: s.startedAt,
        endTime: s.endedAt ?? Date.now(),
        exitCode: s.exitCode,
        error: wasRunning ? '[stale] 上一次进程退出时仍在运行；新进程不接管' : s.error,
        totalOutputLines: s.totalOutputLines,
        lastOutputAt: s.startedAt,
        lastSummaryEmittedAt: 0,
        summaryDirty: false,
        logStream: null,
        logPath: s.logPath,
        rootPid: null,
        detectedPort: null,
      };
      this.tasks.set(s.taskId, task);
    }
  }

  /**
   * 终止任务。
   */
  kill(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return false;

    const rootPid = task.rootPid ?? task.child?.pid ?? null;
    const label = task.label;
    const commandPreview = task.command.length > 80
      ? `${task.command.slice(0, 77)}...`
      : task.command;

    task.status = 'killed';
    task.endTime = Date.now();
    task.error = '被用户终止';
    if (!task.detectedPort && task.outputLines.length > 0) {
      const port = detectListenPort(task.outputLines.join('\n'));
      if (port) task.detectedPort = port;
    }
    this.appendOutput(task, Buffer.from('[terminated by user]\n'), '');
    this.killTaskProcesses(task);
    console.log(
      `[bg-task] 用户终止后台任务 ${taskId}${rootPid ? ` rootPid=${rootPid}` : ''}`
        + `${task.detectedPort ? ` port=${task.detectedPort}` : ''} label="${label}" command="${commandPreview}"`,
    );
    this.closeLogStream(task);
    this.markSummaryDirty(taskId);
    setTimeout(() => {
      task.child = null;
    }, 2500);
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
        this.killTaskProcesses(task);
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
 * 按 sessionId 的 manager 缓存。
 *
 * - 同一 sessionId 复用同一个 manager（保留任务列表）
 * - 不同 sessionId 互不可见（物理隔离贯穿子进程）
 * - 兼容旧调用：{@link getBackgroundTaskManager}(workDir) 等价于 sessionId='default'
 */
const managersBySession = new Map<string, BackgroundTaskManager>();

/**
 * 获取或创建指定 session 的 BackgroundTaskManager。
 *
 * @param sessionId 会话标识；同一 sessionId 多次调用返回同一实例
 * @param workDir   工作目录；实例已存在时会同步更新 spawn cwd
 */
export function getBackgroundTaskManagerFor(
  sessionId: string,
  workDir: string,
): BackgroundTaskManager {
  const resolved = path.resolve(workDir);
  let m = managersBySession.get(sessionId);
  if (!m) {
    m = new BackgroundTaskManager(resolved, sessionId);
    managersBySession.set(sessionId, m);
    return m;
  }
  if (path.resolve(m.getWorkDir()).toLowerCase() !== resolved.toLowerCase()) {
    m.setWorkDir(resolved);
  }
  return m;
}

/** 在所有 session 的 manager 中查找拥有该 taskId 的实例（UI stop 与 spawn session 不一致时兜底） */
export function findBackgroundTaskManagerOwning(taskId: string): BackgroundTaskManager | null {
  for (const mgr of managersBySession.values()) {
    const status = mgr.getStatus(taskId);
    if (status?.status === 'running') return mgr;
  }
  return null;
}

/**
 * 兼容旧入口：默认 sessionId='default'。
 *
 * @deprecated 新代码请使用 {@link getBackgroundTaskManagerFor}
 */
export function getBackgroundTaskManager(workDir?: string): BackgroundTaskManager {
  return getBackgroundTaskManagerFor('default', workDir || process.cwd());
}

/**
 * 重置全部 session 的 manager 缓存（仅测试使用）。
 *
 * @internal
 */
export function __resetBackgroundTaskManagers(): void {
  for (const m of managersBySession.values()) {
    try { m.dispose(); } catch { /* ignore */ }
  }
  managersBySession.clear();
}
