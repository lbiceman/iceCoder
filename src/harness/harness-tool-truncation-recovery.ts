/**
 * LLM 输出触顶或 write/edit 参数疑似截断时，跳过易截断工具并注入恢复提示。
 */

import type { LLMResponse, UnifiedMessage } from '../llm/types.js';
import type { ToolCall } from '../llm/types.js';
import { buildWrappedArgumentFormatHint } from '../tools/tool-arguments-normalizer.js';

export const TRUNCATION_SENSITIVE_WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'append_file',
  'batch_edit_file',
  'patch_file',
]);

export interface TruncationRecoveryInput {
  toolCalls: ToolCall[];
  finishReason: LLMResponse['finishReason'];
  outputTokens: number;
  maxOutputTokens?: number;
}

export function hasTruncationSensitiveWriteTools(toolCalls: ToolCall[] | undefined): boolean {
  return !!toolCalls?.some((tc) => TRUNCATION_SENSITIVE_WRITE_TOOLS.has(tc.name));
}

function extractToolPath(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const raw = args.path ?? args.filePath ?? args.file_path;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** write/edit 类工具缺少 path 等必填字段（常见于 max_tokens 截断后 JSON 不完整）。 */
export function writeToolMissingRequiredPath(tc: ToolCall): boolean {
  if (!TRUNCATION_SENSITIVE_WRITE_TOOLS.has(tc.name)) return false;
  return !extractToolPath(tc.arguments as Record<string, unknown> | undefined);
}

/** 输出 token 是否顶到单次上限（finishReason 可能仍为 tool_calls）。 */
export function isOutputAtTokenCeiling(outputTokens: number, maxOutputTokens: number | undefined): boolean {
  if (!maxOutputTokens || maxOutputTokens <= 0 || outputTokens <= 0) return false;
  return outputTokens >= Math.floor(maxOutputTokens * 0.98);
}

export function shouldPlanTruncatedWriteToolRecovery(input: TruncationRecoveryInput): boolean {
  const writes = input.toolCalls.filter((tc) => TRUNCATION_SENSITIVE_WRITE_TOOLS.has(tc.name));
  if (writes.length === 0) return false;

  if (input.finishReason === 'length') return true;

  const missingPath = writes.filter(writeToolMissingRequiredPath);
  if (missingPath.length === 0) return false;

  if (isOutputAtTokenCeiling(input.outputTokens, input.maxOutputTokens)) return true;

  return missingPath.some((tc) => {
    const content = tc.arguments?.content;
    return typeof content === 'string' && content.length >= 500;
  });
}

export function buildTruncatedWriteToolRecoveryUserMessage(toolNames: string[]): string {
  const list = [...new Set(toolNames)].join(', ');
  return [
    `[System] Previous tool call(s) (${list}) were skipped because the model output likely hit max_tokens and arguments were truncated (missing path or incomplete JSON).`,
    'Continue NOW with a smaller strategy:',
    '- patch_file: one small unified diff hunk',
    '- edit_file: short exact search string + small replace',
    '- append_file: small chunks with both path and content',
    '- or split into multiple smaller writes/appends',
    'Do NOT repeat the same full-file payload.',
  ].join('\n');
}

export function buildSkippedTruncatedWriteToolMessage(toolName: string): string {
  return [
    `[Tool skipped] Output likely hit max_tokens; ${toolName} arguments were truncated or missing required fields (e.g. path).`,
    'Use patch_file (small diff), edit_file (short search/replace), append_file in chunks (path + content), or split writes.',
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
