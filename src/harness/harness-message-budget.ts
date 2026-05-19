import type { UnifiedMessage } from '../llm/types.js';
import {
  OLD_SUBAGENT_SUMMARY_CHARS,
  SUBAGENT_RESULT_KEEP_RECENT,
  TOOL_RESULT_BUDGET_PER_MESSAGE,
  TOOL_RESULT_KEEP_RECENT,
} from './harness-constants.js';
import { isSubAgentToolResult } from './harness-message-utils.js';

/**
 * 压缩过旧子代理 tool 结果正文；保留 `summary:\\n` 前头部，对摘要段单独限长。
 */
export function truncateOldSubAgentResult(content: string): string {
  const marker = '\nsummary:\n';
  const markerIndex = content.indexOf(marker);
  if (markerIndex < 0) {
    return content.length > OLD_SUBAGENT_SUMMARY_CHARS
      ? `${content.slice(0, OLD_SUBAGENT_SUMMARY_CHARS)}\n...[旧子代理结果已裁剪，原始长度 ${content.length} 字符]`
      : content;
  }

  const header = content.slice(0, markerIndex + marker.length);
  const summary = content.slice(markerIndex + marker.length);
  if (summary.length <= OLD_SUBAGENT_SUMMARY_CHARS) return content;
  return `${header}${summary.slice(0, OLD_SUBAGENT_SUMMARY_CHARS)}\n...[旧子代理摘要已裁剪，原始长度 ${summary.length} 字符]`;
}

/**
 * 工具结果预算裁剪。
 *
 * 对旧的工具结果做大小预算裁剪，防止上下文爆炸。
 * 越早的工具结果裁剪越激进，最近的保持完整。
 */
export function applyToolResultBudget(messages: UnifiedMessage[]): void {
  // 保留最近 6 条 tool 消息不裁剪，对更早的做渐进式截断
  const KEEP_RECENT = TOOL_RESULT_KEEP_RECENT;
  const BUDGET_PER_MESSAGE = TOOL_RESULT_BUDGET_PER_MESSAGE;

  let toolMsgCount = 0;
  // 从后往前数 tool 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool') toolMsgCount++;
  }

  if (toolMsgCount <= KEEP_RECENT) return;

  // 从前往后裁剪旧的 tool 消息
  let seen = 0;
  const cutoff = toolMsgCount - KEEP_RECENT;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    seen++;
    if (seen > cutoff) break;

    if (msg.content.length > BUDGET_PER_MESSAGE) {
      messages[i] = {
        ...msg,
        content: msg.content.substring(0, BUDGET_PER_MESSAGE)
          + `\n...[工具结果已裁剪，原始长度 ${msg.content.length} 字符]`,
      };
    }
  }
}

/**
 * 子代理结果本身已经是摘要；长对话里只保留最近几条完整摘要，旧摘要再次压缩。
 */
export function applySubAgentResultRetention(messages: UnifiedMessage[]): void {
  let subAgentResultCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isSubAgentToolResult(msg)) continue;

    subAgentResultCount++;
    if (subAgentResultCount <= SUBAGENT_RESULT_KEEP_RECENT) continue;

    messages[i] = {
      ...msg,
      content: truncateOldSubAgentResult(msg.content),
    };
  }
}
