/**
 * 后台任务进度 UI 通路推送（方案 B）。
 *
 * Phase 4b 的核心：把 BackgroundTaskManager 的 running task 状态
 * 通过 WebSocket 以 `bg_task_update` 事件推送到聊天框，前端渲染为
 * ephemeral chip（不持久化到聊天历史）。
 *
 * 触发时机：
 * - 5 分钟心跳（仅 running 任务）
 * - 任务状态变更立刻推送（completed / failed / timeout / killed）
 * - Hang 检测（running 但 lastOutputAt > 30min）— 推一次 hang 警示
 *
 * 设计为可独立测试 + 轻量接入：
 * - chat-ws.ts 只需在初始化时 `new BgTaskPusher(broadcaster).attach(mgr)`，dispose 时调 `detach()`
 * - 不依赖 WebSocket 具体实现 — broadcaster 是注入函数
 */

import {
  BG_SUMMARY_INTERVAL_MS,
} from '../tools/shell-runtime-classifier.js';
import type {
  BackgroundTaskManager,
  RunningTaskSummary,
} from '../tools/background-task-manager.js';

/** 推送给前端的事件结构 */
export interface BgTaskUpdatePayload {
  type: 'bg_task_update';
  sessionId: string;
  timestamp: string;
  tasks: BgTaskUpdateEntry[];
}

export interface BgTaskUpdateEntry {
  taskId: string;
  label: string;
  command?: string;
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
  elapsed: string;
  elapsedMs: number;
  /** 距上次摘要新增的输出行数（completed 时为总行数） */
  newLines: number;
  exitCode?: number | null;
  error?: string | null;
  /** 终态推送（状态变更触发） */
  isTerminal: boolean;
  /** Hang 提示（运行中、进程不可达且 lastOutputAt > 30min） */
  isHang: boolean;
  /** OS 进程仍存活 */
  processAlive?: boolean;
}

/** 注入的广播函数：把 JSON 字符串发给所有当前 session 的 WS 客户端 */
export type BgPushBroadcaster = (sessionId: string, jsonBody: string) => void;

export interface BgTaskPusherOptions {
  /** 心跳间隔（默认 BG_SUMMARY_INTERVAL_MS） */
  intervalMs?: number;
  /** Hang 检测阈值（默认 30 分钟） */
  hangThresholdMs?: number;
}

/** 内部：把 RunningTaskSummary 映射为对外 entry */
function toEntry(
  s: RunningTaskSummary,
  hangThresholdMs: number,
  command?: string,
): BgTaskUpdateEntry {
  const now = Date.now();
  // 仅当进程已退出/不可达且长时间无输出时才判 hang；dev server 编译完成后常静默但仍存活
  const isHang =
    s.status === 'running'
    && !s.processAlive
    && (now - s.lastOutputAt) > hangThresholdMs;
  return {
    taskId: s.taskId,
    label: s.label,
    ...(command ? { command } : {}),
    status: s.status,
    elapsed: s.elapsed,
    elapsedMs: s.elapsedMs,
    newLines: s.status === 'running' ? s.newLinesSinceLastSummary : s.totalOutputLines,
    exitCode: s.exitCode,
    error: s.error,
    isTerminal: s.isTerminal,
    isHang,
    processAlive: s.processAlive,
  };
}

const DEFAULT_HANG_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * 构建 session 后台任务快照（connected / session_switched 用）。
 * 包含 running 与尚未 cleanup 的终态任务。
 */
export function buildBgTaskSnapshot(
  manager: BackgroundTaskManager,
  hangThresholdMs: number = DEFAULT_HANG_THRESHOLD_MS,
): BgTaskUpdateEntry[] {
  const runningById = new Map<string, RunningTaskSummary>();
  for (const s of manager.getRunningSummary({ onlyDirtyOrDue: false })) {
    runningById.set(s.taskId, s);
  }

  const entries: BgTaskUpdateEntry[] = [];
  for (const t of manager.list()) {
    const running = runningById.get(t.taskId);
    if (running) {
      entries.push(toEntry(running, hangThresholdMs, t.command));
      continue;
    }
    if (t.status === 'running') {
      entries.push({
        taskId: t.taskId,
        label: t.label,
        command: t.command,
        status: 'running',
        elapsed: t.elapsed,
        elapsedMs: t.elapsedMs,
        newLines: 0,
        exitCode: null,
        error: t.error,
        isTerminal: false,
        isHang: false,
      });
      continue;
    }
    entries.push({
      taskId: t.taskId,
      label: t.label,
      command: t.command,
      status: t.status,
      elapsed: t.elapsed,
      elapsedMs: t.elapsedMs,
      newLines: 0,
      exitCode: t.exitCode,
      error: t.error,
      isTerminal: true,
      isHang: false,
    });
  }

  entries.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return 0;
  });
  return entries;
}

/** 仅 running 任务（ETL Shell Dock / connected 快照用） */
export function buildBgTaskRunningSnapshot(
  manager: BackgroundTaskManager,
  hangThresholdMs: number = DEFAULT_HANG_THRESHOLD_MS,
): BgTaskUpdateEntry[] {
  return buildBgTaskSnapshot(manager, hangThresholdMs)
    .filter((t) => t.status === 'running' && !t.isTerminal);
}

/**
 * 后台任务推送器。
 *
 * 一个 manager 对应一个 pusher（典型使用：每个活跃 session 各一个）。
 */
export class BgTaskPusher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly hangThresholdMs: number;
  private readonly attachments = new Map<string, {
    manager: BackgroundTaskManager;
    handler: (s: RunningTaskSummary) => void;
  }>();

  constructor(
    private readonly broadcaster: BgPushBroadcaster,
    options: BgTaskPusherOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? BG_SUMMARY_INTERVAL_MS;
    this.hangThresholdMs = options.hangThresholdMs ?? 30 * 60 * 1000;
  }

  /**
   * 附加到指定 BackgroundTaskManager，不卸载其它 session 的监听。
   */
  attach(manager: BackgroundTaskManager): void {
    this.detachSession(manager.sessionId);
    const handler = (s: RunningTaskSummary) => this.emitStatusChange(manager, s);
    manager.on('taskStatusChanged', handler);
    this.attachments.set(manager.sessionId, { manager, handler });
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
    }
  }

  detachSession(sessionId: string): void {
    const att = this.attachments.get(sessionId);
    if (!att) return;
    att.manager.off('taskStatusChanged', att.handler);
    this.attachments.delete(sessionId);
    if (this.attachments.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 解除全部附加（清理 timer + 事件）。
   */
  detach(): void {
    for (const sid of [...this.attachments.keys()]) this.detachSession(sid);
  }

  /**
   * 手动触发一次心跳（测试 / 调试用）。
   */
  tick(): void {
    for (const { manager } of this.attachments.values()) {
      this.tickManager(manager);
    }
  }

  private tickManager(manager: BackgroundTaskManager): void {
    const summaries = manager.getRunningSummary({ onlyDirtyOrDue: false });
    const running = summaries.filter((s) => s.status === 'running');
    if (running.length === 0) return;
    const entries = running.map((s) => toEntry(s, this.hangThresholdMs, s.command));
    this.broadcast(manager, entries);
    manager.markSummaryEmitted(running.map((s) => s.taskId));
  }

  /** 任务状态变更立刻推送（spawn / 终态；不等心跳 tick） */
  private emitStatusChange(manager: BackgroundTaskManager, s: RunningTaskSummary): void {
    this.broadcast(manager, [toEntry(s, this.hangThresholdMs, s.command)]);
  }

  /** 组装 payload 并交给 broadcaster */
  private broadcast(manager: BackgroundTaskManager, entries: BgTaskUpdateEntry[]): void {
    if (entries.length === 0) return;
    const payload: BgTaskUpdatePayload = {
      type: 'bg_task_update',
      sessionId: manager.sessionId,
      timestamp: new Date().toISOString(),
      tasks: entries,
    };
    try {
      this.broadcaster(manager.sessionId, JSON.stringify(payload));
    } catch {
      /* ignore broadcaster errors — 不影响任务本身 */
    }
  }
}
