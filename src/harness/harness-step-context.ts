import type { UnifiedMessage } from '../llm/types.js';

/**
 * 自尾部向前收集最近 `max` 条 tool 结果，并反向匹配对应 assistant `toolCalls` 得到名称与签名。
 */
export function collectRecentToolTraces(
  messages: UnifiedMessage[],
  max: number,
): Array<{ toolName: string; signature: string; success: boolean; error?: string }> {
  const traces: Array<{ toolName: string; signature: string; success: boolean; error?: string }> = [];
  // 倒序遍历，找最近 N 条 tool result
  for (let i = messages.length - 1; i >= 0 && traces.length < max; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    const content = msg.content;
    const failed = content.includes('Tool execution error:') || content.includes('工具执行错误');
    const errorMatch = content.match(/(?:Tool execution error|工具执行错误)[:：]\s*([^\n]{1,200})/);
    // 反向查找最近的 assistant tool_calls 以拿到 toolName 与 args
    let toolName = 'unknown';
    let signature = '';
    for (let j = i - 1; j >= 0; j--) {
      const m = messages[j];
      if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
      const matchTC = m.toolCalls.find(tc => tc.id === msg.toolCallId);
      if (matchTC) {
        toolName = matchTC.name;
        signature = `${matchTC.name}:${JSON.stringify(matchTC.arguments ?? {})}`;
      }
      break;
    }
    traces.unshift({
      toolName,
      signature: signature || toolName,
      success: !failed,
      error: failed ? (errorMatch?.[1] ?? content.slice(0, 200)) : undefined,
    });
  }
  return traces;
}

/** 收集最近若干条 tool 错误摘要（中英错误前缀）。 */
export function collectRecentErrors(messages: UnifiedMessage[], max: number): string[] {
  const errors: string[] = [];
  for (let i = messages.length - 1; i >= 0 && errors.length < max; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool' || typeof msg.content !== 'string') continue;
    const content = msg.content;
    if (content.includes('Tool execution error:') || content.includes('工具执行错误')) {
      errors.unshift(content.slice(0, 240));
    }
  }
  return errors;
}
