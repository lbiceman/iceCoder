import { describe, expect, it } from 'vitest';
import {
  containsEmbeddedThinking,
  EmbeddedThinkingStreamFilter,
  stripEmbeddedThinking,
} from '../../src/harness/thinking-content-strip.js';
import {
  AssistantVisibleStreamFilter,
  sanitizeAssistantContentForUser,
} from '../../src/harness/text-tool-call-salvage.js';

const MIMO_SAMPLE = `<think>用户问"你是谁？"，这是一个简单的自我介绍问题。我应该简洁地回答。</think>

我是 **iceCoder**，一个智能编程助手，由 Cursor AI 提供支持。`;

describe('thinking-content-strip', () => {
  it('detects and strips redacted_thinking blocks', () => {
    expect(containsEmbeddedThinking(MIMO_SAMPLE)).toBe(true);
    const stripped = stripEmbeddedThinking(MIMO_SAMPLE);
    expect(stripped).not.toContain('redacted_thinking');
    expect(stripped).not.toContain('自我介绍问题');
    expect(stripped).toContain('iceCoder');
  });

  it('EmbeddedThinkingStreamFilter strips incrementally', () => {
    const filter = new EmbeddedThinkingStreamFilter();
    expect(filter.feed('<think>内部')).toBe('');
    expect(filter.feed('推理</think>\n\n你好')).toBe('\n\n你好');
    expect(filter.flush()).toBe('');
  });

  it('AssistantVisibleStreamFilter applies thinking before tool stripping', () => {
    const filter = new AssistantVisibleStreamFilter();
    expect(filter.feed('<think>x</think>可见')).toBe('可见');
    expect(filter.flush()).toBe('');
  });

  it('sanitizeAssistantContentForUser removes thinking for display', () => {
    expect(sanitizeAssistantContentForUser(MIMO_SAMPLE)).toBe(
      '我是 **iceCoder**，一个智能编程助手，由 Cursor AI 提供支持。',
    );
  });
});
