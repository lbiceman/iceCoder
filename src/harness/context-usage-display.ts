import type { ToolDefinition, UnifiedMessage } from '../llm/types.js';
import { resolveCompactionUsage } from '../llm/token-estimator.js';
import { readEffectiveContextWindowTokens } from './context-window-tier.js';
import type { TokenUsageTotals } from './types.js';

export interface BuildTotalTokenUsageOptions {
  lastInputTokens?: number;
  lastOutputTokens?: number;
  /** 压缩后等场景：不计入上一轮 API prompt，圆环仅反映本地估算 + tools */
  localOnly?: boolean;
}

/**
 * 构建与压缩判定一致的 token 用量快照（供 step / WS / 圆环 UI）。
 *
 * effectiveUsed = max(localEstimate + toolsOverhead, lastApiPromptTokens)
 */
export function buildTotalTokenUsageWithContext(
  messages: UnifiedMessage[],
  tools: ToolDefinition[] | undefined,
  options: BuildTotalTokenUsageOptions = {},
): TokenUsageTotals {
  const lastInputTokens = options.lastInputTokens ?? 0;
  const lastOutputTokens = options.lastOutputTokens ?? 0;
  const lastApiPromptTokens = options.localOnly ? 0 : lastInputTokens;
  const contextWindow = readEffectiveContextWindowTokens();
  const { effectiveUsed } = resolveCompactionUsage({
    messages,
    tools,
    lastApiPromptTokens,
  });
  return {
    inputTokens: lastInputTokens,
    outputTokens: lastOutputTokens,
    effectiveUsed,
    contextWindow,
  };
}
