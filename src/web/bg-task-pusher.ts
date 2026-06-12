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
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
  elapsed: string;
  /** 距上次摘要新增的输出行数（completed 时为总行数） */
  newLines: number;
  exitCode?: number | null;
  /** 终态推送（状态变更触发） */
  isTerminal: boolean;
  /** Hang 提示（运行中但 lastOutputAt > 30min） */
  isHang: boolean;
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
function toEntry(s: RunningTaskSummary, hangThresholdMs: number): BgTaskUpdateEntry {
  const now = Date.now();
  const isHang =
    s.status === 'running' && (now - s.lastOutputAt) > hangThresholdMs;
  return {
    taskId: s.taskId,
    label: s.label,
    status: s.status,
    elapsed: s.elapsed,
    newLines: s.status === 'running' ? s.newLinesSinceLastSummary : s.totalOutputLines,
    exitCode: s.exitCode,
    isTerminal: s.isTerminal,
    isHang,
  };
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
  private manager: BackgroundTaskManager | null = null;
  private statusChangedHandler: ((s: RunningTaskSummary) => void) | null = null;

  constructor(
    private readonly broadcaster: BgPushBroadcaster,
    options: BgTaskPusherOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? BG_SUMMARY_INTERVAL_MS;
    this.hangThresholdMs = options.hangThresholdMs ?? 30 * 60 * 1000;
  }

  /**
   * 附加到指定 BackgroundTaskManager。
   *
   * - 启动心跳 timer
   * - 订阅 `taskStatusChanged` 立刻推送终态
   */
  attach(manager: BackgroundTaskManager): void {
    if (this.manager) this.detach();
    this.manager = manager;
    this.statusChangedHandler = (s) => this.emitStatusChange(s);
    manager.on('taskStatusChanged', this.statusChangedHandler);
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  /**
   * 解除附加（清理 timer + 事件）。
   */
  detach(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.manager && this.statusChangedHandler) {
      this.manager.off('taskStatusChanged', this.statusChangedHandler);
    }
    this.manager = null;
    this.statusChangedHandler = null;
  }

  /**
   * 手动触发一次心跳（测试 / 调试用）。
   */
  tick(): void {
    if (!this.manager) return;
    const summaries = this.manager.getRunningSummary({ onlyDirtyOrDue: false });
    const running = summaries.filter((s) => s.status === 'running');
    if (running.length === 0) return;

    const entries = running.map((s) => toEntry(s, this.hangThresholdMs));
    this.broadcast(entries);

    // 标记本轮已 emit（不影响 LLM 通路的独立 emit 节流）
    this.manager.markSummaryEmitted(running.map((s) => s.taskId));
  }

  /** 任务状态变更立刻推送（spawn / 终态；不等心跳 tick） */
  private emitStatusChange(s: RunningTaskSummary): void {
    if (!this.manager) return;
    this.broadcast([toEntry(s, this.hangThresholdMs)]);
  }

  /** 组装 payload 并交给 broadcaster */
  private broadcast(entries: BgTaskUpdateEntry[]): void {
    if (!this.manager || entries.length === 0) return;
    const payload: BgTaskUpdatePayload = {
      type: 'bg_task_update',
      sessionId: this.manager.sessionId,
      timestamp: new Date().toISOString(),
      tasks: entries,
    };
    try {
      this.broadcaster(this.manager.sessionId, JSON.stringify(payload));
    } catch {
      /* ignore broadcaster errors — 不影响任务本身 */
    }
  }
}
