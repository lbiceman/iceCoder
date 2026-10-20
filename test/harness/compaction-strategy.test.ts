/**
 * compaction-strategy：会话笔记截断、压缩锚点文案、对话聚焦摘录。
 */

import { describe, it, expect } from 'vitest';
import type { UnifiedMessage } from '../../src/llm/types.js';
import {
  MAX_SESSION_NOTES_COMPACT_CHARS,
  FILE_TOOLS_PRESERVE_FULL_OUTPUT,
  applyLightMicrocompactToolClear,
  buildClearedToolResultStub,
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

describe('applyLightMicrocompactToolClear · pressure clear', () => {
  type Call = { id: string; name: string; args: Record<string, unknown>; content: string; meta?: UnifiedMessage['toolResultMeta'] };

  function build(calls: Call[], filler = 6) {
    const messages: UnifiedMessage[] = [{ role: 'user', content: 'task' }];
    for (const c of calls) {
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: c.id, name: c.name, arguments: c.args }] });
      messages.push({ role: 'tool', toolCallId: c.id, content: c.content, ...(c.meta ? { toolResultMeta: c.meta } : {}) });
    }
    for (let i = 0; i < filler; i++) {
      messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `f${i}`, name: 'glob', arguments: {} }] });
      messages.push({ role: 'tool', toolCallId: `f${i}`, content: 'short' });
    }
    const toolCallIdToName = new Map<string, string>();
    const toolCallArgs = new Map<string, Record<string, unknown>>();
    const msgAssistantRound = new Map<number, number>();
    let round = 0;
    messages.forEach((m, i) => {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        round++;
        for (const tc of m.toolCalls) {
          toolCallIdToName.set(tc.id, tc.name);
          toolCallArgs.set(tc.id, tc.arguments);
        }
      }
      msgAssistantRound.set(i, round);
    });
    return { messages, opts: { keepLastAssistantToolRounds: 5, toolCallIdToName, msgAssistantRound, currentAssistantRound: round, toolCallArgs } };
  }

  const readMeta = (path: string, start: number, end: number, total: number): UnifiedMessage['toolResultMeta'] => ({
    toolName: 'read_file', strategy: 'full', originalChars: 1, originalTokens: 1, injectedChars: 1, injectedTokens: 1,
    path, lines: { start, end, total },
  });

  it('keeps old reads that nothing superseded', () => {
    const body = 'theme '.repeat(500);
    const { messages, opts } = build([
      { id: 'r1', name: 'read_file', args: { path: 'tokens.css' }, content: body, meta: readMeta('tokens.css', 1, 300, 300) },
    ]);
    const next = applyLightMicrocompactToolClear(messages, opts);
    expect(next.find(m => m.toolCallId === 'r1')).toBe(messages.find(m => m.toolCallId === 'r1'));
  });

  it('clears a read superseded by a later covering read or an edit, keeping content', () => {
    const body = 'theme '.repeat(500);
    const { messages, opts } = build([
      { id: 'r1', name: 'read_file', args: { path: 'tokens.css' }, content: body, meta: readMeta('tokens.css', 1, 300, 300) },
      { id: 'r2', name: 'read_file', args: { path: './tokens.css' }, content: body, meta: readMeta('./tokens.css', 1, 300, 300) },
      { id: 'a1', name: 'read_file', args: { path: 'a.ts' }, content: body, meta: readMeta('a.ts', 1, 40, 40) },
      { id: 'e1', name: 'edit_file', args: { path: 'a.ts', search: 'x', replace: 'y' }, content: 'ok' },
    ]);

    const next = applyLightMicrocompactToolClear(messages, opts);
    const r1 = next.find(m => m.toolCallId === 'r1')!;
    const a1 = next.find(m => m.toolCallId === 'a1')!;
    expect(r1.apiSealedBy).toBe('pressureClear');
    expect(r1.apiSealedContent).toContain('[Old tool result cleared for context] read_file path=tokens.css lines 1-300 of 300');
    expect(r1.content).toBe(body);
    expect(a1.apiSealedBy).toBe('pressureClear');
    expect(next.find(m => m.toolCallId === 'e1')!.apiSealedBy).toBeUndefined();
  });

  it('a rejected range read does not supersede an earlier successful read', () => {
    const body = 'theme '.repeat(500);
    const { messages, opts } = build([
      { id: 'r1', name: 'read_file', args: { path: 'tokens.css' }, content: body, meta: readMeta('tokens.css', 1, 300, 300) },
      {
        id: 'r2', name: 'read_file', args: { path: 'tokens.css', offset: 1, limit: 300 }, content: 'Error: over cap',
        meta: { toolName: 'read_file', strategy: 'full', originalChars: 1, originalTokens: 1, injectedChars: 1, injectedTokens: 1 },
      },
    ]);
    const next = applyLightMicrocompactToolClear(messages, opts);
    expect(next.find(m => m.toolCallId === 'r1')!.apiSealedBy).toBeUndefined();
  });

  it('points cleared command output at its spill file', () => {
    const { messages, opts } = build([
      {
        id: 'c1', name: 'run_command', args: { command: 'npm test' }, content: 'PASS '.repeat(400),
        meta: { toolName: 'run_command', strategy: 'head_tail', originalChars: 9, originalTokens: 9, injectedChars: 1, injectedTokens: 1, spillPath: '/s/c1.log' },
      },
    ]);
    const next = applyLightMicrocompactToolClear(messages, opts);
    const c1 = next.find(m => m.toolCallId === 'c1')!;
    expect(c1.apiSealedContent).toContain('tool=run_command');
    expect(c1.apiSealedContent).toContain('This placeholder is NOT the tool output');
    expect(c1.apiSealedContent).toContain('Full original output saved at: /s/c1.log');
    expect(c1.apiSealedContent).toContain('read_file path="/s/c1.log"');
    expect(c1.content).toBe('PASS '.repeat(400));
    expect(applyLightMicrocompactToolClear(next, opts).find(m => m.toolCallId === 'c1')).toBe(c1);
  });

  it('says plainly when a cleared command output was not saved', () => {
    const { messages, opts } = build([
      {
        id: 'c2', name: 'run_command', args: { command: 'npm test' }, content: 'FAIL '.repeat(400),
        meta: { toolName: 'run_command', strategy: 'full', originalChars: 2000, originalTokens: 500, injectedChars: 2000, injectedTokens: 500 },
      },
    ]);
    const c2 = applyLightMicrocompactToolClear(messages, opts).find(m => m.toolCallId === 'c2')!;
    expect(c2.apiSealedContent).toContain('The original output was not saved; re-run the tool');
  });

  it('leaves short unsaved non-file results alone', () => {
    const { messages, opts } = build([
      { id: 'c3', name: 'run_command', args: { command: 'ls' }, content: 'a.ts\nb.ts' },
    ]);
    expect(applyLightMicrocompactToolClear(messages, opts).find(m => m.toolCallId === 'c3')!.apiSealedBy).toBeUndefined();
  });
});

describe('buildClearedToolResultStub', () => {
  it('tells the model a cleared read is not file content and that a reread shows the current version', () => {
    const stub = buildClearedToolResultStub({
      msg: {
        role: 'tool', toolCallId: 'r', content: 'x'.repeat(3000),
        toolResultMeta: {
          toolName: 'read_file', strategy: 'full', originalChars: 3000, originalTokens: 750, injectedChars: 3000, injectedTokens: 750,
          path: 'src/a.css', lines: { start: 1, end: 120, total: 400 },
        },
      },
      toolName: 'read_file',
    });
    expect(stub.startsWith('[Old tool result cleared for context]')).toBe(true);
    expect(stub).toContain('NOT the file content');
    expect(stub).toContain('read_file path=src/a.css offset=1 limit=120');
    expect(stub).toContain('CURRENT content');
  });
});
