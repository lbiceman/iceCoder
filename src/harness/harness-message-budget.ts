import type { UnifiedMessage } from '../llm/types.js';
import {
  OLD_SUBAGENT_SUMMARY_CHARS,
  SUBAGENT_RESULT_KEEP_RECENT,
} from './harness-constants.js';
import { isSubAgentToolResult } from './harness-message-utils.js';

/** 旧版 tool budget 封存正文里的提示（只用于识别历史会话里没有 apiSealedBy 的封存） */
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
      ? `${content.slice(0, OLD_SUBAGENT_SUMMARY_CHARS)}\n...[older sub-agent result trimmed; original length: ${content.length} characters]`
      : content;
  }

  const header = content.slice(0, markerIndex + marker.length);
  const summary = content.slice(markerIndex + marker.length);
  if (summary.length <= OLD_SUBAGENT_SUMMARY_CHARS) return content;
  return `${header}${summary.slice(0, OLD_SUBAGENT_SUMMARY_CHARS)}\n...[older sub-agent summary trimmed; original length: ${summary.length} characters]`;
}

/** 是否为旧版 3000 字符 tool budget 封存（显式字段优先，旧落盘回退正文 marker） */
export function isToolBudgetSealed(msg: UnifiedMessage): boolean {
  if (msg.apiSealedBy === 'toolBudget') return true;
  if (msg.apiSealedBy) return false;
  return typeof msg.apiSealedContent === 'string'
    && msg.apiSealedContent.includes(TOOL_RESULT_BUDGET_TRUNCATION_MARKER);
}

/** 是否已完成子代理封存（显式字段优先，旧落盘回退正文 marker） */
export function isSubAgentSealed(msg: UnifiedMessage): boolean {
  if (msg.apiSealedBy === 'subAgent') return true;
  if (msg.apiSealedBy) return false;
  return typeof msg.apiSealedContent === 'string'
    && msg.apiSealedContent.includes(SUBAGENT_SEAL_LEGACY_MARKER);
}

/**
 * 解除历史会话里的 3000 字符 tool budget 封存，让模型重新看到写入时的结果。
 *
 * 原地替换为不含封存字段的新对象（不改共享的旧对象）；返回解除条数。
 * 只在加载历史时发生一次，之后不会再产生这种封存。
 */
export function releaseLegacyToolBudgetSeals(messages: UnifiedMessage[]): number {
  let released = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== 'tool' || !isToolBudgetSealed(msg)) continue;
    const { apiSealedContent: _sealed, apiSealedBy: _by, ...rest } = msg;
    messages[i] = rest;
    released++;
  }
  return released;
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

    if (msg.apiSealedBy || isSubAgentSealed(msg) || isToolBudgetSealed(msg)) continue;

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
