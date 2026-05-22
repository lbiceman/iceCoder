/**
 * preserveOnCompaction：C 类纠偏消息在硬压缩 split 时保留在 recent 后缀。
 */

import { describe, expect, it } from 'vitest';

import { ContextCompactor } from '../../src/harness/context-compactor.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function filler(count: number): UnifiedMessage[] {
  const msgs: UnifiedMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push(
      { role: 'user', content: `user turn ${i}: ${'x'.repeat(120)}` },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `tc-${i}`, name: 'read_file', arguments: { path: `f${i}.ts` } }],
      },
      { role: 'tool', toolCallId: `tc-${i}`, content: 'file body '.repeat(200) },
    );
  }
  return msgs;
}

describe('ContextCompactor preserveOnCompaction', () => {
  it('keeps correction injects with preserveOnCompaction in recent suffix after compact', async () => {
    const lifecycleInject: UnifiedMessage = {
      role: 'user',
      content: '[System] You have been reading/analyzing for 5 rounds without making any edits.',
      preserveOnCompaction: true,
    };

    const messages: UnifiedMessage[] = [
      ...filler(30),
      lifecycleInject,
      { role: 'assistant', content: 'Will edit now.' },
    ];

    const compactor = new ContextCompactor({
      tokenThreshold: 500,
      keepRecentMinTokens: 100,
      keepRecentMaxTokens: 50_000,
      keepRecentMinMessages: 2,
      enableLLMSummary: false,
    });

    expect(compactor.needsCompaction(messages)).toBe(true);

    const compacted = await compactor.compact(messages, async () => ({
      content: 'summary',
      toolCalls: undefined,
    }));

    const preserved = compacted.some(
      m => m.preserveOnCompaction === true
        && typeof m.content === 'string'
        && m.content.includes('[System] You have been reading/analyzing'),
    );
    expect(preserved).toBe(true);
  });
});
