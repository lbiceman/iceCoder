import type { ToolCall } from '../llm/types.js';

export const REDACTED_TOOL_ARGUMENT = '[redacted]';

/** interactive_shell write 的 input 属于交互凭证/回答，不得进入日志或持久化历史。 */
export function isSensitiveInteractiveShellWrite(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
): boolean {
  return toolName === 'interactive_shell'
    && typeof args?.action === 'string'
    && args.action.trim().toLowerCase() === 'write';
}

/**
 * 返回可安全用于 checkpoint、telemetry、日志和 UI 事件的工具参数副本。
 * 实际工具执行仍必须使用原始参数。
 */
export function redactToolArguments(
  toolName: string,
  args: Record<string, any>,
): Record<string, any> {
  if (!isSensitiveInteractiveShellWrite(toolName, args)) return args;
  return {
    ...args,
    input: REDACTED_TOOL_ARGUMENT,
  };
}

export function redactToolCall(toolCall: ToolCall): ToolCall {
  const redactedArguments = redactToolArguments(toolCall.name, toolCall.arguments);
  if (redactedArguments === toolCall.arguments) return toolCall;
  return {
    ...toolCall,
    arguments: redactedArguments,
  };
}

export function redactToolCalls(toolCalls: ToolCall[] | undefined): ToolCall[] | undefined {
  return toolCalls?.map(redactToolCall);
}
