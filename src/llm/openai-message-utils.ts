import type { UnifiedMessage } from './types.js';

/** 合并全部 system 为一条并置于首位（供 MiniMax 等严格 OpenAI 兼容端点使用）。 */
export function collapseUnifiedSystemMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  const systemParts: string[] = [];
  const rest: UnifiedMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n');
      if (text) systemParts.push(text);
    } else {
      rest.push(msg);
    }
  }
  if (systemParts.length === 0) return messages;
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest];
}
