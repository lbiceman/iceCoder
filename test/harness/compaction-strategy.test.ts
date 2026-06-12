/**
 * compaction-strategy：会话笔记截断、压缩锚点文案、对话聚焦摘录。
 */

import { describe, it, expect } from 'vitest';
import type { UnifiedMessage } from '../../src/llm/types.js';
import {
  MAX_SESSION_NOTES_COMPACT_CHARS,
  FILE_TOOLS_PRESERVE_FULL_OUTPUT,
  buildCompactBoundaryContent,
  buildRecentDialogueFocusContent,
  truncateSessionNotesForCompact,
} from '../../src/harness/compaction-strategy.js';

describe('compaction-strategy', () => {
  it('truncateSessionNotesForCompact 超长笔记截断并标记（D）', () => {
    const long = 'a'.repeat(MAX_SESSION_NOTES_COMPACT_CHARS + 500);
    const { text, truncated } = truncateSessionNotesForCompact(long);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain('session notes truncated for compaction');
    expect(text).toContain('data/sessions/{sessionId}.session-notes.md');
  });

  it('truncateSessionNotesForCompact 带 sessionId 时使用具体路径', () => {
    const long = 'x'.repeat(MAX_SESSION_NOTES_COMPACT_CHARS + 100);
    const { text } = truncateSessionNotesForCompact(long, undefined, 'sess-abc');
    expect(text).toContain('data/sessions/sess-abc.session-notes.md');
  });

  it('buildCompactBoundaryContent 包含 token / 消息计数（A）', () => {
    const c = buildCompactBoundaryContent({
      beforeTokens: 100,
      afterTokens: 40,
      beforeMessages: 20,
      afterMessages: 8,
    });
    expect(c).toContain('<compact_boundary>');
    expect(c).toContain('pre_compact_estimated_tokens: 100');
    expect(c).toContain('post_compact_estimated_tokens: 40');
    expect(c).toContain('recent-dialogue-focus');
  });

  it('buildRecentDialogueFocusContent 摘录最近真实 user / assistant（E）', () => {
    const messages: UnifiedMessage[] = [
      { role: 'user', content: '<context-summary>\nold</context-summary>' },
      { role: 'user', content: 'Real task: fix login bug' },
      {
        role: 'assistant',
        content: 'Will inspect auth module.',
        toolCalls: [{ id: 'g1', name: 'grep_file', arguments: { pattern: 'x' } }],
      },
      { role: 'user', content: 'Also check session expiry.' },
      { role: 'assistant', content: 'Done reviewing.' },
    ];
    const focus = buildRecentDialogueFocusContent(messages);
    expect(focus).toContain('<recent-dialogue-focus>');
    expect(focus).toContain('Also check session expiry.');
    expect(focus).toContain('Real task: fix login bug');
    expect(focus).toContain('grep_file');
    expect(focus).not.toContain('context-summary');
  });

  it('FILE_TOOLS_PRESERVE_FULL_OUTPUT includes batch_edit_file and diff_files for Web UI diff', () => {
    expect(FILE_TOOLS_PRESERVE_FULL_OUTPUT.has('batch_edit_file')).toBe(true);
    expect(FILE_TOOLS_PRESERVE_FULL_OUTPUT.has('diff_files')).toBe(true);
    expect(FILE_TOOLS_PRESERVE_FULL_OUTPUT.has('patch_file')).toBe(true);
  });
});
