import { describe, it, expect } from 'vitest';
import { countExtractionConversationMessages } from '../../src/harness/harness-memory.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('countExtractionConversationMessages', () => {
  it('仅统计 user/assistant，不含 tool/system', () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', toolCalls: [{ id: '1', name: 'read_file', arguments: {} }] },
      { role: 'tool', content: 'ok', toolCallId: '1' },
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'done' },
    ];
    expect(countExtractionConversationMessages(messages)).toBe(3);
    expect(messages.length).toBe(5);
  });

  it('互斥跳过时应用 conversation 计数而非 messages.length', () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: 'turn1' },
      { role: 'assistant', content: 'a1', toolCalls: [{ id: '1', name: 'run_command', arguments: {} }] },
      { role: 'tool', content: 'out', toolCallId: '1' },
      { role: 'assistant', content: 'a2', toolCalls: [{ id: '2', name: 'run_command', arguments: {} }] },
      { role: 'tool', content: 'out2', toolCallId: '2' },
      { role: 'user', content: 'turn2' },
      { role: 'assistant', content: 'a3' },
    ];
    const convLen = countExtractionConversationMessages(messages);
    expect(convLen).toBe(5);
    expect(messages.length).toBe(7);
    // 修复前若用 messages.length 作游标，slice(conv) 会恒为空
    const allConversation = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    expect(allConversation.slice(messages.length)).toHaveLength(0);
    expect(allConversation.slice(convLen)).toHaveLength(0);
    expect(allConversation.slice(0)).toHaveLength(5);
  });
});
