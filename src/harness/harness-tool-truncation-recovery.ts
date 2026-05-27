/**
 * LLM 输出触顶 (finishReason=length) 时，跳过易截断的 write/edit 工具并注入恢复提示。
 */

import type { UnifiedMessage } from '../llm/types.js';
import type { ToolCall } from '../llm/types.js';
import { buildWrappedArgumentFormatHint } from '../tools/tool-arguments-normalizer.js';

export const TRUNCATION_SENSITIVE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'batch_edit_file',
  'patch_file',
]);

export function hasTruncationSensitiveWriteTools(toolCalls: ToolCall[] | undefined): boolean {
  return !!toolCalls?.some((tc) => TRUNCATION_SENSITIVE_WRITE_TOOLS.has(tc.name));
}

export function buildTruncatedWriteToolRecoveryUserMessage(toolNames: string[]): string {
  const list = [...new Set(toolNames)].join(', ');
  return [
    `[System] Previous tool call(s) (${list}) were skipped because the model output hit max_tokens (finishReason: length) and arguments were likely truncated.`,
    'Continue NOW with a smaller strategy:',
    '- patch_file: one small unified diff hunk',
    '- edit_file: short exact search string + small replace',
    '- or split into multiple smaller writes/appends',
    'Do NOT repeat the same full-file payload.',
  ].join('\n');
}

export function buildSkippedTruncatedWriteToolMessage(toolName: string): string {
  return [
    `[Tool skipped] Output hit max_tokens (finishReason: length). ${toolName} arguments were likely truncated.`,
    'Use patch_file (small diff), edit_file (short search/replace), or split into smaller writes.',
    buildWrappedArgumentFormatHint(),
  ].join(' ');
}

export interface TruncatedWriteToolRecoveryResult {
  skippedWriteCalls: ToolCall[];
  toolCallsToRun: ToolCall[];
  injectedMessages: UnifiedMessage[];
}

/**
 * 将 write/edit 类工具从本轮执行列表剥离，并生成 synthetic tool 回复 + user 恢复提示。
 */
export function planTruncatedWriteToolRecovery(
  toolCalls: ToolCall[],
): TruncatedWriteToolRecoveryResult {
  const skippedWriteCalls = toolCalls.filter((tc) => TRUNCATION_SENSITIVE_WRITE_TOOLS.has(tc.name));
  const toolCallsToRun = toolCalls.filter((tc) => !TRUNCATION_SENSITIVE_WRITE_TOOLS.has(tc.name));

  const injectedMessages: UnifiedMessage[] = skippedWriteCalls.map((tc) => ({
    role: 'tool',
    toolCallId: tc.id,
    content: buildSkippedTruncatedWriteToolMessage(tc.name),
  }));

  if (skippedWriteCalls.length > 0) {
    injectedMessages.push({
      role: 'user',
      content: buildTruncatedWriteToolRecoveryUserMessage(skippedWriteCalls.map((tc) => tc.name)),
    });
  }

  return { skippedWriteCalls, toolCallsToRun, injectedMessages };
}
