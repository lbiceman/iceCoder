/**
 * 交互式 Shell（PTY）管理器。
 *
 * 与 BackgroundTaskManager 并列，负责 /shell 协作模式下的持久 PTY 会话：
 * - 按 session 至多一个活跃 ish_* task
 * - node-pty spawn 真实交互 shell
 * - lifespan: copilot — Stop Agent 不杀；删 session / shutdown 才杀（见 session-shell-control）
 *
 * awaiting_input 检测见 {@link detectPromptInTail}（任务 1.3）。
 */

import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import { analyzeShellSandbox } from './shell-sandbox.js';
import { classifyShellCollabCommandRisk } from './shell-collab-command-risk.js';
import { buildShellChildEnv } from './shell-host-guard.js';
import { resolveShellExecutable } from './shell-spawn-env.js';
import { killWindowsProcessTree } from './shell-process-kill.js';
import {
  detectPromptInTail,
  DEFAULT_PROMPT_PATTERNS,
  PROMPT_TAIL_BYTES,
  type PromptPattern,
} from './interactive-shell-prompt-detect.js';

/** 协管 PTY 生命周期：copilot 随 session 删除 / shutdown 终止，Stop Agent 不杀 */
export type InteractiveShellLifespan = 'copilot';

/** PTY 任务状态 */
export type InteractiveShellStatus = 'running' | 'completed' | 'killed';

/** 活跃 PTY 任务（进程内持有 pty 引用） */
export interface InteractiveShellTask {
  taskId: string;
  sessionId: string;
  pty: IPty | null;
  /** 环形缓冲：最近输出行 */
  outputBuffer: string[];
  /** 累计输出行数（含被环形缓冲淘汰的） */
  totalOutputLines: number;
  /** 当前是否有尚未换行的输出行 */
  outputLineOpen: boolean;
  /** 有界原始输出缓冲及其全局起始偏移 */
  outputText: string;
  outputStartOffset: number;
  /** 单调递增的输出偏移（UTF-16 code unit） */
  cursor: number;
  awaitingInput: boolean;
  lastPromptHint: string | null;
  /** 最近一次检测到的提示原文 */
  lastPromptText: string | null;
  lifespan: InteractiveShellLifespan;
  status: InteractiveShellStatus;
  shell: string;
  cwd: string;
  label: string;
  initialCommand: string | null;
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
  rootPid: number | null;
  /** 落盘日志写流；null 表示未启用落盘 */
  logStream: WriteStream | null;
  /** 落盘日志路径（绝对路径） */
  logPath: string | null;
  /** PTY 原始输出尾部（用于提示检测） */
  rawOutputTail: string;
  /** password/passphrase 输入，仅用于从 PTY 落盘日志中移除可能的回显 */
  sensitiveLogValues: string[];
  /** 为处理跨输出 chunk 的敏感回显而暂存的日志尾部 */
  logRedactionTail: string;
}

/** read / check 返回的状态 */
export type InteractiveShellReadStatus = 'running' | 'awaiting_input' | 'completed' | 'killed';

/** 对外暴露的任务摘要（不含 pty 引用） */
export interface InteractiveShellTaskSummary {
  taskId: string;
  sessionId: string;
  status: InteractiveShellStatus;
  shell: string;
  cwd: string;
  label: string;
  initialCommand: string | null;
  totalOutputLines: number;
  cursor: number;
  awaitingInput: boolean;
  lastPromptHint: string | null;
  lifespan: InteractiveShellLifespan;
  startTime: number;
  endTime: number | null;
  exitCode: number | null;
}

export interface InteractiveShellStartResult {
  taskId: string;
  status: 'started' | 'reused';
  shell: string;
  cwd: string;
  error?: string;
}

export interface InteractiveShellStopResult {
  status: 'stopped';
  error?: string;
}

/** 增量 read 结果（since 为上次返回的 cursor） */
export interface InteractiveShellReadResult {
  status: InteractiveShellReadStatus;
  output: string;
  /** 下次 read 应传入的单调输出偏移 */
  cursor: number;
  totalOutputLines: number;
  /** since 早于环形缓冲起点时为 true（中间行已淘汰） */
  truncated: boolean;
  /** awaiting_input 时：检测到的提示文本 */
  promptText?: string;
  /** awaiting_input 时：password / passphrase / yes_no / text */
  promptHint?: string;
  /** 最近输出摘要（最后若干行，供 AI 兜底判断） */
  recentOutput?: string;
}

const MAX_OUTPUT_LINES = 500;
/** read 可回溯的原始输出上限；更早输出通过 truncated 标记。 */
const MAX_OUTPUT_CHARS = 128 * 1024;
/** 每个 manager 最多保留的终态任务数。 */
const MAX_RETAINED_TERMINAL_TASKS = 20;
/** read 返回 recentOutput 的最大行数 */
const RECENT_OUTPUT_LINES = 30;
/** wait_until=idle：输出静默多久视为 idle（毫秒） */
const IDLE_QUIET_MS = 400;
/** waitFor 轮询间隔（毫秒） */
const WAIT_POLL_MS = 50;
/** waitFor 默认超时（毫秒） */
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

/** shell_exec / shell_wait 等待条件 */
export type ShellWaitUntil = 'idle' | 'prompt' | 'exit' | 'output';

export interface ShellWaitOptions {
  since?: number;
  until: ShellWaitUntil;
  timeoutMs?: number;
  /** shell_wait：普通文本匹配（非正则） */
  pattern?: string;
}

export type ShellWaitStatus = InteractiveShellReadStatus | 'timeout';

export interface ShellWaitResult {
  status: ShellWaitStatus;
  output: string;
  cursor: number;
  totalOutputLines: number;
  truncated: boolean;
  exitCode?: number | null;
  promptHint?: string;
  promptText?: string;
  matched?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InteractiveShellManagerOptions {
  logDir?: string;
  promptPatterns?: PromptPattern[];
  promptTailBytes?: number;
}

function generateTaskId(): string {
  return 'ish_' + Math.random().toString(36).substring(2, 8);
}

function resolveInteractivePtySpawn(): { file: string; args: string[] } {
  const shell = resolveShellExecutable();
  if (process.platform === 'win32') {
    return { file: shell, args: [] };
  }
  const base = path.basename(shell).toLowerCase();
  if (base.includes('bash') || base.includes('zsh')) {
    return { file: shell, args: ['-i'] };
  }
  return { file: shell, args: [] };
}

function commandLineEnding(): string {
  return process.platform === 'win32' ? '\r\n' : '\n';
}

function toSummary(task: InteractiveShellTask): InteractiveShellTaskSummary {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    status: task.status,
    shell: task.shell,
    cwd: task.cwd,
    label: task.label,
    initialCommand: task.initialCommand,
    totalOutputLines: task.totalOutputLines,
    cursor: task.cursor,
    awaitingInput: task.awaitingInput,
    lastPromptHint: task.lastPromptHint,
    lifespan: task.lifespan,
    startTime: task.startTime,
    endTime: task.endTime,
    exitCode: task.exitCode,
  };
}

/**
 * 交互式 Shell 管理器。
 *
 * 每个 sessionId 一个实例；同一 session 同时最多一个 running 的 ish_* task。
 */
export class InteractiveShellManager {
  private tasks = new Map<string, InteractiveShellTask>();
  private workDir: string;
  readonly sessionId: string;
  /** 日志根目录；默认 `<workDir>/data/sessions/<sid>/ish` */
  private readonly logDir: string;
  private readonly promptPatterns: PromptPattern[];
  private readonly promptTailBytes: number;

  constructor(workDir: string, sessionId: string, options: InteractiveShellManagerOptions = {}) {
    this.workDir = path.resolve(workDir);
    this.sessionId = sessionId;
    this.logDir = options.logDir ?? path.join(this.workDir, 'data', 'sessions', sessionId, 'ish');
    this.promptPatterns = options.promptPatterns ?? DEFAULT_PROMPT_PATTERNS;
    this.promptTailBytes = options.promptTailBytes ?? PROMPT_TAIL_BYTES;
  }

  getWorkDir(): string {
    return this.workDir;
  }

  setWorkDir(workDir: string): void {
    this.workDir = path.resolve(workDir);
  }

  /** 当前 session 下 running 的 PTY task（至多一个） */
  getActiveTask(): InteractiveShellTask | null {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') return task;
    }
    return null;
  }

  getTask(taskId: string): InteractiveShellTaskSummary | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return toSummary(task);
  }

  listForSession(): InteractiveShellTaskSummary[] {
    const out: InteractiveShellTaskSummary[] = [];
    for (const task of this.tasks.values()) {
      out.push(toSummary(task));
    }
    return out.sort((a, b) => {
      if (a.status === 'running' && b.status !== 'running') return -1;
      if (b.status === 'running' && a.status !== 'running') return 1;
      return b.startTime - a.startTime;
    });
  }

  /**
   * 增量读取 PTY 输出（自 since 输出偏移起的新内容）。
   *
   * diff-only 模型（对齐 BackgroundTaskManager.getOutputSince）：
   * - since 为上次 read 返回的 cursor（单调输出偏移）
   * - 无换行 chunk 也会推进 cursor，且不会重复返回旧内容
   * - since 早于环形缓冲起点时 truncated=true
   */
  read(taskId: string, since: number = 0): InteractiveShellReadResult | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const cursor = task.cursor;
    const sinceClamped = Math.max(0, Math.min(since, cursor));
    const truncated = sinceClamped < task.outputStartOffset;
    const start = Math.max(0, sinceClamped - task.outputStartOffset);
    const status = this.resolveReadStatus(task);
    const recentOutput = this.buildRecentOutput(task);

    const result: InteractiveShellReadResult = {
      status,
      output: task.outputText.slice(start),
      cursor,
      totalOutputLines: task.totalOutputLines,
      truncated,
      recentOutput,
    };

    if (status === 'awaiting_input') {
      result.promptText = task.lastPromptText ?? undefined;
      result.promptHint = task.lastPromptHint ?? undefined;
    }

    return result;
  }

  /**
   * 向 PTY 写入交互输入（password / yes-no / text）。
   * 写入后清除 awaitingInput，待下一轮输出重新检测。
   */
  writeInput(taskId: string, input: string): { ok: boolean; error?: string } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: '任务不存在' };
    if (task.status !== 'running' || !task.pty) {
      return { ok: false, error: 'PTY 未运行' };
    }
    if (!task.awaitingInput) {
      return {
        ok: false,
        error: '当前非交互输入态；命令请使用 shell_exec',
      };
    }

    const promptHint = task.lastPromptHint;
    const isCredentialInput = promptHint === 'password' || promptHint === 'passphrase';
    if (!isCredentialInput && looksLikeShellCommandFragment(input)) {
      return {
        ok: false,
        error: '检测到 shell 命令或命令片段；请使用 shell_exec 执行命令',
      };
    }

    if (promptHint === 'password' || promptHint === 'passphrase') {
      if (!task.sensitiveLogValues.includes(input)) {
        task.sensitiveLogValues.push(input);
      }
      this.writeSanitizedLog(task, `[interactive input: ${promptHint}] [redacted]${commandLineEnding()}`);
    }

    task.awaitingInput = false;
    task.lastPromptHint = null;
    task.lastPromptText = null;
    // 已处理的提示不得参与后续检测；只扫描本次交互输入之后的新输出。
    task.rawOutputTail = '';
    task.pty.write(input + commandLineEnding());
    return { ok: true };
  }

  /** check 为 read 别名（需求 §5.2） */
  check(taskId: string, since: number = 0): InteractiveShellReadResult | null {
    return this.read(taskId, since);
  }

  /**
   * 向 PTY 写入原始字节（控制键等；不经 sandbox / 命令分类）。
   */
  writeRaw(taskId: string, data: string): { ok: boolean; error?: string; cursor?: number } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: '任务不存在' };
    if (task.status !== 'running' || !task.pty) {
      return { ok: false, error: 'PTY 未运行' };
    }
    task.pty.write(data);
    return { ok: true, cursor: task.cursor };
  }

  /**
   * 向 PTY 写入 shell 命令（command + 换行）。
   * 仅非 awaitingInput 态允许；交互输入请用 writeInput。
   */
  writeCommand(taskId: string, command: string): { ok: boolean; error?: string; since?: number } {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: '任务不存在' };
    if (task.status !== 'running' || !task.pty) {
      return { ok: false, error: 'PTY 未运行' };
    }
    if (task.awaitingInput) {
      return {
        ok: false,
        error: '当前处于交互输入态；请使用 interactive_shell write 提供密码或回答',
      };
    }

    const trimmed = command.trim();
    if (!trimmed) return { ok: false, error: 'command 不能为空' };

    const sandbox = analyzeShellSandbox(trimmed, {
      workDir: this.workDir,
      includeBlacklist: false,
    });
    if (sandbox.blocked) {
      return { ok: false, error: sandbox.message ?? '[Sandbox / Blocked]' };
    }

    const since = task.cursor;
    task.pty.write(trimmed + commandLineEnding());
    return { ok: true, since };
  }

  /**
   * 等待 PTY 输出达到指定条件（idle / prompt / exit / output）。
   * 超时不会 kill PTY。
   */
  async waitFor(taskId: string, options: ShellWaitOptions): Promise<ShellWaitResult | null> {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const timeoutMs = Math.min(
      120_000,
      Math.max(1_000, options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    const since = options.since ?? 0;
    const deadline = Date.now() + timeoutMs;
    let lastOutputOffset = task.cursor;
    let lastChangeAt = Date.now();

    while (Date.now() < deadline) {
      const current = this.tasks.get(taskId);
      if (!current) return null;

      if (current.status === 'completed' || current.status === 'killed') {
        return this.buildWaitResult(current, since, current.status);
      }

      if (current.awaitingInput) {
        return this.buildWaitResult(current, since, 'awaiting_input');
      }

      if (options.until === 'prompt' && current.awaitingInput) {
        return this.buildWaitResult(current, since, 'awaiting_input');
      }

      if (options.until === 'exit') {
        // running — keep waiting until completed/killed or timeout
      } else if (options.until === 'output') {
        const readResult = this.read(taskId, since);
        if (readResult?.output) {
          if (!options.pattern) {
            return this.buildWaitResult(current, since, readResult.status);
          }
          if (readResult.output.includes(options.pattern)) {
            return this.buildWaitResult(current, since, readResult.status, { matched: true });
          }
        }
      } else if (options.until === 'idle') {
        if (current.cursor !== lastOutputOffset) {
          lastOutputOffset = current.cursor;
          lastChangeAt = Date.now();
        } else if (Date.now() - lastChangeAt >= IDLE_QUIET_MS) {
          return this.buildWaitResult(current, since, 'running');
        }
      }

      await sleep(WAIT_POLL_MS);
    }

    const current = this.tasks.get(taskId);
    if (!current) return null;
    return this.buildWaitResult(current, since, 'timeout');
  }

  private buildWaitResult(
    task: InteractiveShellTask,
    since: number,
    status: ShellWaitStatus,
    extra: { matched?: boolean } = {},
  ): ShellWaitResult {
    const readResult = this.read(task.taskId, since);
    const result: ShellWaitResult = {
      status,
      output: readResult?.output ?? '',
      cursor: readResult?.cursor ?? task.cursor,
      totalOutputLines: readResult?.totalOutputLines ?? task.totalOutputLines,
      truncated: readResult?.truncated ?? false,
      ...(task.exitCode !== null ? { exitCode: task.exitCode } : {}),
      ...(readResult?.promptHint !== undefined ? { promptHint: readResult.promptHint } : {}),
      ...(readResult?.promptText !== undefined ? { promptText: readResult.promptText } : {}),
      ...(extra.matched !== undefined ? { matched: extra.matched } : {}),
    };
    return result;
  }

  /**
   * @internal 测试：注入 PTY 输出片段
   */
  _testInjectOutput(taskId: string, data: string): void {
    const task = this.tasks.get(taskId);
    if (task) this.appendOutput(task, data);
  }

  /**
   * 启动持久 PTY。
   *
   * - 若已有 running task：复用同一 taskId（T5 / §3.1）
   * - 可选 initial command 先走不可配置的 hard block / 宿主保护；
   *   可配置规则由 shellMandatoryConfirm 层处理
   */
  start(options: { command?: string; label?: string } = {}): InteractiveShellStartResult {
    const active = this.getActiveTask();
    if (active) {
      return {
        taskId: active.taskId,
        status: 'reused',
        shell: active.shell,
        cwd: active.cwd,
      };
    }
    this.pruneTerminalTasks();

    const command = options.command?.trim() ?? '';
    if (command) {
      const sandbox = analyzeShellSandbox(command, {
        workDir: this.workDir,
        includeBlacklist: false,
      });
      if (sandbox.blocked) {
        return {
          taskId: '',
          status: 'started',
          shell: '',
          cwd: this.workDir,
          error: sandbox.message ?? '[Sandbox / Blocked]',
        };
      }
    }

    const { file, args } = resolveInteractivePtySpawn();
    const cwd = this.workDir;
    let proc: IPty;
    try {
      proc = pty.spawn(file, args, {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd,
        env: buildShellChildEnv(this.sessionId),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        taskId: '',
        status: 'started',
        shell: file,
        cwd,
        error: `PTY 启动失败: ${message}`,
      };
    }

    const taskId = generateTaskId();
    const now = Date.now();
    const { stream: logStream, logPath } = this.openLogStream(taskId);
    const task: InteractiveShellTask = {
      taskId,
      sessionId: this.sessionId,
      pty: proc,
      outputBuffer: [],
      totalOutputLines: 0,
      outputLineOpen: false,
      outputText: '',
      outputStartOffset: 0,
      cursor: 0,
      awaitingInput: false,
      lastPromptHint: null,
      lastPromptText: null,
      lifespan: 'copilot',
      status: 'running',
      shell: file,
      cwd,
      label: options.label?.trim() || command.substring(0, 50) || file,
      initialCommand: command || null,
      startTime: now,
      endTime: null,
      exitCode: null,
      rootPid: proc.pid,
      logStream,
      logPath,
      rawOutputTail: '',
      sensitiveLogValues: [],
      logRedactionTail: '',
    };

    proc.onData((data) => this.appendOutput(task, data));
    proc.onExit(({ exitCode }) => {
      if (task.status !== 'running') return;
      task.status = 'completed';
      task.exitCode = exitCode;
      task.endTime = Date.now();
      task.pty = null;
      this.closeLogStream(task);
      this.clearSensitiveLogState(task);
      this.pruneTerminalTasks();
    });

    this.tasks.set(taskId, task);

    if (command) {
      proc.write(command + commandLineEnding());
    }

    return {
      taskId,
      status: 'started',
      shell: file,
      cwd,
    };
  }

  /** 终止指定 PTY；清 task 记录但保留 session 协作模式（由上层 ShellCollabState 管理） */
  stop(taskId: string): InteractiveShellStopResult {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { status: 'stopped', error: '任务不存在' };
    }
    if (task.status !== 'running') {
      return { status: 'stopped' };
    }

    this.killPty(task);
    task.status = 'killed';
    task.endTime = Date.now();
    task.exitCode = task.exitCode ?? null;
    this.appendOutputLine(task, '[terminated by interactive_shell stop]');
    task.pty = null;
    this.closeLogStream(task);
    this.clearSensitiveLogState(task);
    this.pruneTerminalTasks();
    return { status: 'stopped' };
  }

  /** 终止本 session 全部 running PTY（删 session / shutdown） */
  killAllRunning(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      this.killPty(task);
      task.status = 'killed';
      task.endTime = Date.now();
      this.appendOutputLine(task, '[terminated by session cleanup]');
      task.pty = null;
      this.closeLogStream(task);
      this.clearSensitiveLogState(task);
      count++;
    }
    this.pruneTerminalTasks();
    return count;
  }

  private openLogStream(taskId: string): { stream: WriteStream | null; logPath: string | null } {
    try {
      mkdirSync(this.logDir, { recursive: true });
      const logPath = path.join(this.logDir, `${taskId}.log`);
      const stream = createWriteStream(logPath, { flags: 'a', encoding: 'utf-8' });
      stream.on('error', () => { /* swallow — 日志失败不阻塞 PTY */ });
      return { stream, logPath };
    } catch {
      return { stream: null, logPath: null };
    }
  }

  private closeLogStream(task: InteractiveShellTask): void {
    if (task.logStream) {
      try {
        if (task.logRedactionTail) {
          task.logStream.write(this.redactSensitiveLogText(task, task.logRedactionTail));
          task.logRedactionTail = '';
        }
        task.logStream.end();
      } catch {
        /* ignore */
      }
      task.logStream = null;
    }
  }

  private clearSensitiveLogState(task: InteractiveShellTask): void {
    task.sensitiveLogValues.length = 0;
    task.logRedactionTail = '';
  }

  dispose(): void {
    this.killAllRunning();
    this.tasks.clear();
  }

  private killPty(task: InteractiveShellTask): void {
    const p = task.pty;
    const rootPid = task.rootPid ?? p?.pid ?? null;
    if (p) {
      try {
        p.kill();
      } catch {
        /* ignore */
      }
    }
    if (process.platform === 'win32' && rootPid != null && rootPid > 0) {
      killWindowsProcessTree(rootPid);
    }
  }

  private appendOutput(task: InteractiveShellTask, data: string): void {
    this.writeSanitizedLog(task, data);

    task.rawOutputTail = (task.rawOutputTail + data).slice(-this.promptTailBytes);
    task.outputText += data;
    task.cursor += data.length;
    if (task.outputText.length > MAX_OUTPUT_CHARS) {
      const removeCount = task.outputText.length - MAX_OUTPUT_CHARS;
      task.outputText = task.outputText.slice(removeCount);
      task.outputStartOffset += removeCount;
    }

    this.appendOutputLines(task, data);

    this.updatePromptState(task);
  }

  private appendOutputLines(task: InteractiveShellTask, data: string): void {
    for (let i = 0; i < data.length; i++) {
      const char = data[i];
      if (char === '\n') {
        if (!task.outputLineOpen) this.pushOutputLine(task, '');
        task.outputLineOpen = false;
        continue;
      }
      if (char === '\r' && data[i + 1] === '\n') continue;
      if (!task.outputLineOpen) {
        this.pushOutputLine(task, '');
        task.outputLineOpen = true;
      }
      task.outputBuffer[task.outputBuffer.length - 1] += char;
    }
  }

  /**
   * 写 PTY 日志时移除 password/passphrase 的潜在回显。
   * 保留最长敏感值减一的原始尾部，避免凭证恰好跨 onData chunk 时泄漏。
   */
  private writeSanitizedLog(task: InteractiveShellTask, data: string): void {
    if (!task.logStream) return;
    try {
      if (task.sensitiveLogValues.length === 0) {
        task.logStream.write(data);
        return;
      }

      const combined = task.logRedactionTail + data;
      const maxSensitiveLength = Math.max(...task.sensitiveLogValues.map(value => value.length));
      let cut = Math.max(0, combined.length - Math.max(0, maxSensitiveLength - 1));

      for (const secret of task.sensitiveLogValues) {
        if (!secret) continue;
        let from = 0;
        while (from < combined.length) {
          const start = combined.indexOf(secret, from);
          if (start < 0) break;
          const end = start + secret.length;
          if (start < cut && end > cut) cut = start;
          from = start + Math.max(1, secret.length);
        }
      }

      const ready = combined.slice(0, cut);
      task.logRedactionTail = combined.slice(cut);
      if (ready) task.logStream.write(this.redactSensitiveLogText(task, ready));
    } catch {
      /* ignore */
    }
  }

  private redactSensitiveLogText(task: InteractiveShellTask, text: string): string {
    let redacted = text;
    for (const secret of task.sensitiveLogValues) {
      if (secret) redacted = redacted.split(secret).join('[redacted]');
    }
    return redacted;
  }

  private updatePromptState(task: InteractiveShellTask): void {
    const detected = detectPromptInTail(
      task.rawOutputTail,
      this.promptPatterns,
      this.promptTailBytes,
    );
    task.awaitingInput = detected.awaitingInput;
    task.lastPromptHint = detected.promptHint;
    task.lastPromptText = detected.promptText;
  }

  private resolveReadStatus(task: InteractiveShellTask): InteractiveShellReadStatus {
    if (task.status === 'completed') return 'completed';
    if (task.status === 'killed') return 'killed';
    if (task.awaitingInput) return 'awaiting_input';
    return 'running';
  }

  private buildRecentOutput(task: InteractiveShellTask): string {
    const lines = task.outputBuffer.slice(-RECENT_OUTPUT_LINES);
    return lines.join('\n');
  }

  private appendOutputLine(task: InteractiveShellTask, line: string): void {
    this.pushOutputLine(task, line);
  }

  private pushOutputLine(task: InteractiveShellTask, line: string): void {
    task.outputBuffer.push(line);
    task.totalOutputLines += 1;
    if (task.outputBuffer.length > MAX_OUTPUT_LINES) {
      task.outputBuffer.splice(0, task.outputBuffer.length - MAX_OUTPUT_LINES);
    }
  }

  private pruneTerminalTasks(): void {
    const terminal = [...this.tasks.values()]
      .filter(task => task.status !== 'running');
    const removeCount = Math.max(0, terminal.length - MAX_RETAINED_TERMINAL_TASKS);
    for (const task of terminal.slice(0, removeCount)) {
      this.tasks.delete(task.taskId);
    }
  }
}

const managersBySession = new Map<string, InteractiveShellManager>();

/** 非凭证交互输入时，拒绝明显 shell 命令/片段（防 write 拆分绕过）。 */
function looksLikeShellCommandFragment(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  if (/^ENTER$/i.test(trimmed)) return true;
  if (classifyShellCollabCommandRisk(trimmed)) return true;
  if (/^(sudo\s+)?(rm|git|drop|shutdown|reboot|chmod|systemctl|kill|curl|wget|del|erase|format|mkfs|dd)\b/i.test(trimmed)) {
    return true;
  }
  if (/^(-[a-zA-Z]+|--[a-zA-Z-]+)(\s+|$)/.test(trimmed)) return true;
  if (/^\/[a-zqf]/i.test(trimmed)) return true;
  return false;
}

/** 获取或创建指定 session 的 InteractiveShellManager */
export function getInteractiveShellManagerFor(
  sessionId: string,
  workDir: string,
): InteractiveShellManager {
  const resolved = path.resolve(workDir);
  let mgr = managersBySession.get(sessionId);
  if (!mgr) {
    mgr = new InteractiveShellManager(resolved, sessionId);
    managersBySession.set(sessionId, mgr);
    return mgr;
  }
  if (path.resolve(mgr.getWorkDir()).toLowerCase() !== resolved.toLowerCase()) {
    mgr.setWorkDir(resolved);
  }
  return mgr;
}

/** 在所有 session 的 manager 中查找拥有该 taskId 的实例 */
export function findInteractiveShellManagerOwning(taskId: string): InteractiveShellManager | null {
  for (const mgr of managersBySession.values()) {
    if (mgr.getTask(taskId)) return mgr;
  }
  return null;
}

/** 清理指定 session 的 manager（会话删除时调用） */
export function disposeInteractiveShellManagerForSession(sessionId: string): boolean {
  const mgr = managersBySession.get(sessionId);
  if (!mgr) return false;
  try {
    mgr.dispose();
  } catch {
    /* ignore */
  }
  managersBySession.delete(sessionId);
  return true;
}

/** 终止指定 session 的运行中 PTY（不销毁 manager 实例） */
export function killAllRunningInteractiveShellsForSession(sessionId: string): number {
  const mgr = managersBySession.get(sessionId);
  if (!mgr) return 0;
  return mgr.killAllRunning();
}

/** 终止全部 session 的运行中 PTY */
export function killAllRunningInteractiveShells(): number {
  let total = 0;
  for (const mgr of managersBySession.values()) {
    total += mgr.killAllRunning();
  }
  return total;
}

/** 清理全部 session 的 manager（优雅关闭时调用） */
export function disposeAllInteractiveShellManagers(): void {
  for (const mgr of managersBySession.values()) {
    try {
      mgr.dispose();
    } catch {
      /* ignore */
    }
  }
  managersBySession.clear();
}

/** @internal 仅测试使用 */
export function __resetInteractiveShellManagers(): void {
  disposeAllInteractiveShellManagers();
}
