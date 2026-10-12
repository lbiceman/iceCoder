/**
 * 定时任务执行结果回写桥：chat-ws-loop 在一轮收口时通知，serve 注入处理函数写回 Store。
 */

import type { StopReason } from '../harness/types.js';

export interface ScheduledTaskResult {
  taskId: string;
  success: boolean;
  error: string | null;
}

export type ScheduledTaskResultHandler = (result: ScheduledTaskResult) => void | Promise<void>;

const STOP_REASON_LABELS: Partial<Record<StopReason, string>> = {
  max_rounds: '达到最大轮次',
  token_budget: 'Token 预算耗尽',
  timeout: '执行超时',
  user_abort: '已被手动中断',
  user_checkpoint: '等待人工确认',
  max_output_tokens: '输出达到 Token 上限',
  stop_hook: '被停止钩子拦截',
  completion_paused: '有待确认的操作，已暂停',
  completion_failed: '收尾确认失败',
  circuit_breaker: '连续工具失败已熔断',
  error: '执行出错',
};

const MAX_DETAIL_CHARS = 300;

export function describeScheduledTaskStop(reason: StopReason | undefined, detail?: string): string {
  const label = (reason && STOP_REASON_LABELS[reason]) || '执行失败';
  if (!detail) return `${label}（详情见任务会话）`;
  const clipped = detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail;
  return `${label}：${clipped}`;
}

let handler: ScheduledTaskResultHandler | null = null;

export function registerScheduledTaskResultHandler(next: ScheduledTaskResultHandler | null): void {
  handler = next;
}

export async function notifyScheduledTaskResult(result: ScheduledTaskResult): Promise<void> {
  if (!handler) return;
  try {
    await handler(result);
  } catch (err) {
    console.warn('[scheduled-tasks] 回写执行结果失败:', err);
  }
}
