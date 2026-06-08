import type { UnifiedMessage } from '../llm/types.js';
import {
  finalizeMessagesForApi,
  normalizeMessages,
} from './context-assembler.js';
import {
  sealSubAgentResultsForApi,
  sealToolResultsForApi,
} from './harness-message-budget.js';

/** 发送管道末尾注入的易变块（不进主历史） */
export interface EphemeralInjections {
  blocks?: string[];
}

/**
 * 将易变块合并为单条 user 消息，追加到 view 末尾（独立消息，不并入 canonical 末条 user）。
 *
 * 易变块之间仍用 `\n\n` 合成一条，避免连续多条 ephemeral user；
 * 不与 canonical 最后一条 user 合并，以免 runtime 等变化时拖累记忆召回等稳定前缀的缓存命中。
 */
function appendEphemeral(view: UnifiedMessage[], ephemeral: EphemeralInjections): void {
  const blocks = (ephemeral.blocks ?? []).filter((block): block is string => Boolean(block));
  if (blocks.length === 0) return;

  view.push({ role: 'user', content: blocks.join('\n\n') });
}

/**
 * 构建当轮 LLM API 请求的消息列表（发送管道唯一入口）。
 *
 * 主历史 `canonical` 只追加；封存字段写在 canonical 对象上；返回视图仅用于当次 API。
 */
export function buildMessagesForLlm(
  canonical: UnifiedMessage[],
  ephemeral: EphemeralInjections = {},
): UnifiedMessage[] {
  sealSubAgentResultsForApi(canonical);
  sealToolResultsForApi(canonical);

  const view = finalizeMessagesForApi(normalizeMessages(canonical.slice()));
  appendEphemeral(view, ephemeral);

  return view.map((m) => ({
    ...m,
    content: m.apiSealedContent ?? m.content,
  }));
}

/** @visibleForTesting */
export { appendEphemeral as mergeEphemeralIntoView };
