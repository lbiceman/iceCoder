/**
 * ContextCompactor 硬压缩后再注入 read_file 结果 — maxReinjectFiles 行为。
 */

import { describe, it, expect } from 'vitest';
import { ContextCompactor } from '../../src/harness/context-compactor.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

function readPair(path: string, content: string, toolCallId: string): UnifiedMessage[] {
  return [
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: toolCallId, name: 'read_file', arguments: { path } }],
    },
    { role: 'tool', toolCallId, content },
  ];
}

describe('ContextCompactor.extractRecentFileContents', () => {
  it('uses maxReinjectFiles from config as unique-path cap', () => {
    const messages: UnifiedMessage[] = [
      ...readPair('a.ts', 'content-a', 'tc-a'),
      ...readPair('b.ts', 'content-b', 'tc-b'),
      ...readPair('c.ts', 'content-c', 'tc-c'),
    ];
    const compactor = new ContextCompactor({
      maxReinjectFiles: 2,
      maxReinjectTokens: 1_000_000,
    });
    const [msg] = compactor.extractRecentFileContents(messages);
    expect(typeof msg.content).toBe('string');
    const text = msg.content as string;
    expect(text).toContain('### c.ts');
    expect(text).toContain('### b.ts');
    expect(text).not.toContain('### a.ts');
  });

  it('lets maxFiles argument override config cap', () => {
    const messages: UnifiedMessage[] = [
      ...readPair('a.ts', 'content-a', 'tc-a'),
      ...readPair('b.ts', 'content-b', 'tc-b'),
    ];
    const compactor = new ContextCompactor({ maxReinjectFiles: 10 });
    const [msg] = compactor.extractRecentFileContents(messages, 1);
    const text = msg.content as string;
    expect(text).toContain('### b.ts');
    expect(text).not.toContain('### a.ts');
  });

  it('clamps maxReinjectFiles to MAX cap', () => {
    const c = new ContextCompactor({ maxReinjectFiles: 200 });
    expect(c.getConfig().maxReinjectFiles).toBe(64);
  });

  it('falls back to default when maxReinjectFiles is invalid', () => {
    const c = new ContextCompactor({ maxReinjectFiles: 0 as unknown as number });
    expect(c.getConfig().maxReinjectFiles).toBe(12);
  });
});
