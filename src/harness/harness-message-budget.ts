import type { UnifiedMessage } from '../llm/types.js';
import {
  OLD_SUBAGENT_SUMMARY_CHARS,
  SUBAGENT_RESULT_KEEP_RECENT,
  TOOL_RESULT_BUDGET_PER_MESSAGE,
  TOOL_RESULT_KEEP_RECENT,
} from './harness-constants.js';
import { isSubAgentToolResult } from './harness-message-utils.js';

/** 写入 apiSealedContent 尾部的 tool budget 提示（仅展示；封存判定用 apiSealedBy） */
export const TOOL_RESULT_BUDGET_TRUNCATION_MARKER = '...[工具结果已裁剪，';

/** 旧会话落盘兼容：子代理封存正文特征 */
const SUBAGENT_SEAL_LEGACY_MARKER = '...[旧子代理';

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

/** 是否已完成 tool budget 封存（显式字段优先，旧落盘回退正文 marker） */
export function isToolBudgetSealed(msg: UnifiedMessage): boolean {
  if (msg.apiSealedBy === 'toolBudget') return true;
  if (msg.apiSealedBy === 'subAgent') return false;
  return typeof msg.apiSealedContent === 'string'
    && msg.apiSealedContent.includes(TOOL_RESULT_BUDGET_TRUNCATION_MARKER);
}

/** 是否已完成子代理封存（显式字段优先，旧落盘回退正文 marker） */
export function isSubAgentSealed(msg: UnifiedMessage): boolean {
  if (msg.apiSealedBy === 'subAgent') return true;
  if (msg.apiSealedBy === 'toolBudget') return false;
  return typeof msg.apiSealedContent === 'string'
    && msg.apiSealedContent.includes(SUBAGENT_SEAL_LEGACY_MARKER);
}

/**
 * 普通工具结果封存裁剪（API 侧）。
 *
 * 最近 N 条 **非子代理** tool 保持完整 content；更早的普通 tool 在首次超 budget 时写入
 * `apiSealedContent` + `apiSealedBy: 'toolBudget'` 后永不再改。
 * 子代理由 {@link sealSubAgentResultsForApi} 单独处理，不参与 KEEP_RECENT 计数。
 */
export function sealToolResultsForApi(messages: UnifiedMessage[]): void {
  const KEEP_RECENT = TOOL_RESULT_KEEP_RECENT;
  const BUDGET_PER_MESSAGE = TOOL_RESULT_BUDGET_PER_MESSAGE;

  let toolMsgCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool' || isSubAgentToolResult(msg)) continue;
    toolMsgCount++;
  }

  if (toolMsgCount <= KEEP_RECENT) return;

  let seen = 0;
  const cutoff = toolMsgCount - KEEP_RECENT;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    if (isSubAgentToolResult(msg)) continue;

    seen++;
    if (seen > cutoff) break;

    if (isToolBudgetSealed(msg)) continue;

    const source = msg.apiSealedContent ?? msg.content;
    if (source.length <= BUDGET_PER_MESSAGE) continue;

    messages[i] = {
      ...msg,
      apiSealedContent: source.substring(0, BUDGET_PER_MESSAGE)
        + `\n...[工具结果已裁剪，原始长度 ${source.length} 字符]`,
      apiSealedBy: 'toolBudget',
    };
  }
}

/**
 * 子代理结果封存：长对话里只保留最近几条完整摘要，写入
 * `apiSealedContent` + `apiSealedBy: 'subAgent'`。
 */
export function sealSubAgentResultsForApi(messages: UnifiedMessage[]): void {
  let subAgentResultCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isSubAgentToolResult(msg)) continue;

    subAgentResultCount++;
    if (subAgentResultCount <= SUBAGENT_RESULT_KEEP_RECENT) continue;

    if (isSubAgentSealed(msg) || isToolBudgetSealed(msg)) continue;

    const sealed = truncateOldSubAgentResult(msg.content);
    if (sealed !== msg.content) {
      messages[i] = {
        ...msg,
        apiSealedContent: sealed,
        apiSealedBy: 'subAgent',
      };
    }
  }
}
