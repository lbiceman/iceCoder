import { describe, it, expect } from 'vitest';
import { collapseUnifiedSystemMessages } from '../../src/llm/openai-adapter.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('collapseUnifiedSystemMessages', () => {
  it('merges multiple system messages into one at index 0', () => {
    const input: UnifiedMessage[] = [
      { role: 'user', content: 'memory recall' },
      { role: 'system', content: 'main prompt' },
      { role: 'user', content: 'task' },
    ];
    const out = collapseUnifiedSystemMessages(input);
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('system');
    expect(out[0].content).toBe('main prompt');
    expect(out[1].role).toBe('user');
    expect(out[2].role).toBe('user');
  });

  it('leaves messages unchanged when there is no system role', () => {
    const input: UnifiedMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ];
    expect(collapseUnifiedSystemMessages(input)).toEqual(input);
  });
});
