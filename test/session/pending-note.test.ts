import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPendingNote,
  getPendingNote,
  clearPendingNote,
  injectPendingNote,
  injectPendingNoteForTurn,
  discardPendingNoteIfUnused,
  formatPendingNoteForHarnessContext,
  formatPendingNoteSuccessMessage,
  parseAlsoCommand,
  parseNextCommand,
  resetPendingNotesForTests,
} from '../../src/session/pending-note.js';

describe('pending-note', () => {
  beforeEach(() => {
    resetPendingNotesForTests();
  });

  it('sets, overwrites, reads, and clears pending note per session', () => {
    setPendingNote('s1', 'first');
    expect(getPendingNote('s1')).toBe('first');
    setPendingNote('s1', 'second');
    expect(getPendingNote('s1')).toBe('second');
    clearPendingNote('s1');
    expect(getPendingNote('s1')).toBeUndefined();
  });

  it('injectPendingNote appends structured note and clears pending note', () => {
    setPendingNote('s1', '严格模式');
    const base = [{ role: 'user' as const, content: 'hello' }];
    const injected = injectPendingNote(base, 's1');

    expect(injected).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'user', content: '[备注] 严格模式' },
    ]);
    expect(getPendingNote('s1')).toBeUndefined();
  });

  it('injectPendingNote is a no-op without pending note', () => {
    const base = [{ role: 'user' as const, content: 'hello' }];
    expect(injectPendingNote(base, 's1')).toBe(base);
  });

  it('discardPendingNoteIfUnused clears note and returns discard message', () => {
    setPendingNote('s1', 'unused');
    expect(discardPendingNoteIfUnused('s1')).toBe('任务已结束，备注未生效');
    expect(getPendingNote('s1')).toBeUndefined();
    expect(discardPendingNoteIfUnused('s1')).toBeUndefined();
  });

  it('formatPendingNoteSuccessMessage includes the note text', () => {
    expect(formatPendingNoteSuccessMessage('修改难度大吗？')).toContain('修改难度大吗？');
  });

  it('formatPendingNoteForHarnessContext treats note as current-turn high-priority instruction', () => {
    const formatted = formatPendingNoteForHarnessContext('用中文思考和回复');
    expect(formatted).toContain('high-priority instruction');
    expect(formatted).toContain('current task');
    expect(formatted).toContain('用中文思考和回复');
  });

  it('injectPendingNoteForTurn inserts note as a user message before the current task', () => {
    const base = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'old task' },
      { role: 'assistant' as const, content: 'old answer' },
      { role: 'user' as const, content: 'new task' },
    ];
    const injected = injectPendingNoteForTurn(base, '用中文思考');

    expect(injected).toHaveLength(5);
    expect(injected[0]).toBe(base[0]);
    expect(injected[3]).toMatchObject({ role: 'user' });
    expect(String(injected[3].content)).toContain('pending_note_for_this_turn');
    expect(String(injected[3].content)).toContain('用中文思考');
    expect(injected[4]).toBe(base[3]);
    expect(base).toHaveLength(4);
  });

  it('parseAlsoCommand supports optional whitespace after /also', () => {
    expect(parseAlsoCommand('/also 严格模式')).toEqual({ matched: true, text: '严格模式' });
    expect(parseAlsoCommand('/also严格模式')).toEqual({ matched: true, text: '严格模式' });
    expect(parseAlsoCommand('/' + 'note 严格模式')).toEqual({ matched: false, text: '' });
    expect(parseAlsoCommand('/next task')).toEqual({ matched: false, text: '' });
    expect(parseAlsoCommand('#skill\n/also 严格模式')).toEqual({ matched: true, text: '严格模式' });
  });

  it('parseNextCommand matches body line when prefixed with skill refs', () => {
    expect(parseNextCommand('/next 修登录页')).toEqual({ matched: true, text: '修登录页' });
    expect(parseNextCommand('#skill\n/next 修登录页')).toEqual({ matched: true, text: '修登录页' });
    expect(parseNextCommand('普通任务')).toEqual({ matched: false, text: '' });
  });
});
