/**
 * Harness 后台任务摘要注入（LLM 通路）。
 *
 * Phase 4a 核心：每轮工具循环前，把当前 session 仍在跑的后台任务摘要
 * 作为一段轻量 `[Background Task Status]` 块注入给模型，避免模型对长任务失忆。
 *
 * 设计原则（避免 CC #11716 stale reminder 坑）：
 * 1. 只在 status === 'running' 时注入；
 * 2. 状态变更立即 invalidate（BgManager 已通过 markSummaryDirty 处理）；
 * 3. 占用预算 ≤ 600 字硬上限；
 * 4. 节流：同一任务每 5 分钟最多注入一次（dirty 优先）。
 *
 * 本模块**仅提供工具函数**，不强行接入 harness.ts 主循环（保持 Phase 4a 可独立验证）。
 * Harness 集成方在调用 LLM 前主动调用 {@link composeBgStatusUserMessage}，把返回的
 * 文本作为额外 user-style 消息插入即可。
 */

import {
  getBackgroundTaskManagerFor,
  type BackgroundTaskManager,
} from '../tools/background-task-manager.js';
import { BG_SUMMARY_INTERVAL_MS } from '../tools/shell-runtime-classifier.js';

/** 后台摘要消息（注入给 LLM 用的中性结构，调用方自行映射到具体 message role） */
export interface BgStatusMessage {
  /** 已格式化的 `[Background Task Status] ... [/Background Task Status]` 文本块 */
  content: string;
  /** 本次摘要覆盖的 taskId 列表（调用方应在使用后回调 {@link markBgSummaryEmitted}） */
  taskIds: string[];
  /** 摘要中包含的 running task 数量 */
  taskCount: number;
}

export interface ComposeBgStatusOptions {
  /** 摘要节流间隔（默认 5 分钟） */
  intervalMs?: number;
  /** 内容最大字符数（默认 600） */
  maxChars?: number;
  /** 自定义 manager（测试用） */
  manager?: BackgroundTaskManager;
}

/**
 * 为指定 session 生成后台任务摘要文本。
 *
 * @returns null 表示当前没有 dirty / due 的 running 任务，调用方应**不**注入任何消息
 */
export function composeBgStatusUserMessage(
  sessionId: string,
  workDir: string,
  options: ComposeBgStatusOptions = {},
): BgStatusMessage | null {
  const intervalMs = options.intervalMs ?? BG_SUMMARY_INTERVAL_MS;
  const maxChars = options.maxChars ?? 600;
  const mgr = options.manager ?? getBackgroundTaskManagerFor(sessionId, workDir);

  const summaries = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs });
  if (summaries.length === 0) return null;

  const content = mgr.formatRunningSummaryBlock({ intervalMs, maxChars });
  if (!content) return null;

  return {
    content,
    taskIds: summaries.map((s) => s.taskId),
    taskCount: summaries.length,
  };
}

/**
 * 标记摘要已被注入（更新节流时间戳）。
 *
 * 调用方在把 {@link composeBgStatusUserMessage} 返回的 content 加入 LLM messages
 * 后必须立即调一次，否则下一轮还会重复发送。
 */
export function markBgSummaryEmitted(
  sessionId: string,
  workDir: string,
  taskIds: string[],
  manager?: BackgroundTaskManager,
): void {
  const mgr = manager ?? getBackgroundTaskManagerFor(sessionId, workDir);
  mgr.markSummaryEmitted(taskIds);
}

/**
 * 一站式 helper：生成摘要并标记 emit（多数 Harness 调用方应直接用这个）。
 *
 * @returns 已格式化文本（null 表示无需注入）
 */
export function takeBgStatusForInjection(
  sessionId: string,
  workDir: string,
  options: ComposeBgStatusOptions = {},
): string | null {
  const msg = composeBgStatusUserMessage(sessionId, workDir, options);
  if (!msg) return null;
  markBgSummaryEmitted(sessionId, workDir, msg.taskIds, options.manager);
  return msg.content;
}
