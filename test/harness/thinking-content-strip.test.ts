import { describe, expect, it } from 'vitest';
import {
  containsEmbeddedThinking,
  EmbeddedThinkingStreamFilter,
  ReasoningSystemTagStreamFilter,
  stripEmbeddedThinking,
  stripSystemTagsFromReasoning,
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

  it('EmbeddedThinkingStreamFilter strips incrementally and routes thinking', () => {
    const filter = new EmbeddedThinkingStreamFilter();
    expect(filter.feed('<think>内部')).toEqual({ visible: '', thinking: '内部' });
    expect(filter.feed('推理</think>\n\n你好')).toEqual({ visible: '\n\n你好', thinking: '推理' });
    expect(filter.flush()).toEqual({ visible: '', thinking: '' });
  });

  it('AssistantVisibleStreamFilter applies thinking before tool stripping', () => {
    const filter = new AssistantVisibleStreamFilter();
    expect(filter.feed('<think>x</think>可见')).toEqual({ visible: '可见', thinking: 'x' });
    expect(filter.flush()).toEqual({ visible: '', thinking: '' });
  });

  it('AssistantVisibleStreamFilter strips system tags from visible stream', () => {
    const filter = new AssistantVisibleStreamFilter();
    expect(filter.feed('<system>\n</system>\n\n正文')).toEqual({ visible: '\n\n正文', thinking: '' });
    expect(filter.flush()).toEqual({ visible: '', thinking: '' });
  });

  it('sanitizeAssistantContentForUser removes thinking for display', () => {
    expect(sanitizeAssistantContentForUser(MIMO_SAMPLE)).toBe(
      '我是 **iceCoder**，一个智能编程助手，由 Cursor AI 提供支持。',
    );
  });

  it('sanitizeAssistantContentForUser removes leaked system tags from reply', () => {
    expect(sanitizeAssistantContentForUser('<system>\n</system>\n\n## 标题')).toBe('## 标题');
  });

  it('stripSystemTagsFromReasoning removes empty and filled system blocks', () => {
    const raw = '先分析路径<system>\n</system>再读 Controller<system-reminder>secret</system-reminder>继续';
    expect(stripSystemTagsFromReasoning(raw)).toBe('先分析路径再读 Controller继续');
  });

  it('ReasoningSystemTagStreamFilter strips system tags incrementally', () => {
    const filter = new ReasoningSystemTagStreamFilter();
    expect(filter.feed('思路<sys')).toBe('思路');
    expect(filter.feed('tem>\nmeta</system>继续')).toBe('继续');
    expect(filter.flush()).toBe('');
  });
});
