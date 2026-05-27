import type { UnifiedMessage } from '../llm/types.js';
import type { StopHookResult } from './stop-hooks.js';

/**
 * 模型「我还要接着干」的前向承诺信号。
 *
 * 注意：本钩子在 `harness-round-no-tools.ts` 中已经被状态门控保护：
 * - 问答 / 查看 / 文档类意图直接跳过；
 * - 没有 pendingWork 且已动过工具的轮次直接跳过。
 *
 * 因此这里只需要识别 **模型自承未完成** 的明确文本承诺，将其拉回到工具调用。
 * 不要再加入「npm test」「manifest」等回顾性关键词，那些会在状态机已确认任务
 * 完成时被误判。
 */
const INCOMPLETE_FORWARD_SIGNALS: readonly string[] = [
  '我需要继续',
  '接下来我会',
  '下一步是',
  '还需要',
  '未完成',
  'I need to continue',
  'next step',
  'will update',
  'will fix',
  'need to update',
  'Let me update',
  'I will fix',
  'I will continue',
  'still need to',
];

export function detectIncompleteForwardSignal(lastContent: string): boolean {
  const text = lastContent.trim();
  if (!text) return false;
  return INCOMPLETE_FORWARD_SIGNALS.some((signal) => text.includes(signal));
}

/**
 * Web 默认停止钩子：仅在模型自承未完成时拦截停手。
 *
 * 用户意图过滤、pendingWork 判断已由 Harness 主循环承担，本函数不再扫描用户输入。
 */
export function evaluateIncompleteTaskStopHook(
  _messages: UnifiedMessage[],
  lastContent: string,
): StopHookResult {
  const hasIncomplete = detectIncompleteForwardSignal(lastContent);
  return {
    shouldContinue: hasIncomplete,
    message: hasIncomplete
      ? 'You identified unfinished work. Continue by calling tools now — do not stop with analysis only.'
      : undefined,
    hookName: 'incomplete_task_check',
  };
}
