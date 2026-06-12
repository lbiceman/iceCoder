/**
 * LLM 请求侧的工具列表规范化：固定顺序（利于前缀缓存）与可选压缩描述长度。
 */

import type { ToolDefinition } from './types.js';

/** 若为 1/true 则截断各工具 description（ICE_SLIM_TOOL_DESC_MAX_CHARS，默认 384） */
export function slimToolDescriptionsEnabled(): boolean {
  const v = process.env.ICE_SLIM_TOOL_DESCRIPTIONS?.trim()?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function slimToolDescriptionsMaxChars(): number {
  const n = Number.parseInt(process.env.ICE_SLIM_TOOL_DESC_MAX_CHARS || '384', 10);
  return Number.isFinite(n) && n >= 48 ? n : 384;
}

/**
 * 按名称字典序排序工具；可选截断过长 description（不改变 name / parameters）。
 */
export function prepareToolsForChatCompletions(
  tools: ToolDefinition[] | undefined,
): ToolDefinition[] | undefined {
  if (!tools?.length) return tools;

  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));

  if (!slimToolDescriptionsEnabled()) return sorted;

  const max = slimToolDescriptionsMaxChars();
  return sorted.map((t) => {
    const d = t.description?.trim() ?? '';
    if (d.length <= max) return t;
    return { ...t, description: `${d.slice(0, Math.max(1, max - 1))}…` };
  });
}
