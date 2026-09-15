import type { ToolCall, UnifiedMessage } from '../llm/types.js';
import { classifyRunCommandResult } from './task-acceptance-tracker.js';

/** 从 tool 消息向前找对应 assistant.toolCalls 项。 */
export function findToolCallForResult(
  messages: UnifiedMessage[],
  toolIndex: number,
): ToolCall | undefined {
  const toolCallId = messages[toolIndex]?.toolCallId;
  if (!toolCallId) return undefined;
  for (let j = toolIndex - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const match = m.toolCalls.find(tc => tc.id === toolCallId);
    if (match) return match;
  }
  return undefined;
}

export function toolResultLooksFailed(content: string): boolean {
  return content.includes('Tool execution error')
    || content.includes('工具执行错误')
    || content.includes('[BranchBudget / Blocked]');
}

/**
 * 正文是否像失败的命令输出（不看命令名字）。
 * 前台失败带 error 前缀；后台 check 带 status/exitCode JSON。
 */
export function looksLikeFailedRunCommandOutput(content: string): boolean {
  if (toolResultLooksFailed(content)) return true;
  const classified = classifyRunCommandResult({ action: 'check' }, content, true);
  return classified?.kind === 'background_failed';
}

/** 该 tool 消息是否为失败的 run_command（exit≠0 / timeout / killed / check failed）。 */
export function isFailedRunCommandToolResult(
  messages: UnifiedMessage[],
  toolIndex: number,
): boolean {
  const msg = messages[toolIndex];
  if (!msg || msg.role !== 'tool' || typeof msg.content !== 'string') return false;
  const tc = findToolCallForResult(messages, toolIndex);
  if (tc?.name !== 'run_command') return false;
  if (looksLikeFailedRunCommandOutput(msg.content)) return true;
  const classified = classifyRunCommandResult(
    (tc.arguments ?? {}) as Record<string, unknown>,
    msg.content,
    false,
  );
  return classified?.kind === 'foreground' && classified.foregroundSuccess === false;
}
