import { describe, it, expect, beforeEach } from 'vitest';
import {
  queueAlsoNote,
  setActiveAlsoRun,
  clearPendingNotesForSession,
  clearPendingNoteForRun,
  appendQueuedAlsoNotesToMessages,
  drainAlsoNotesForRun,
  parseAlsoCommand,
  parseNextCommand,
  resetPendingNotesForTests,
} from '../../src/session/pending-note.js';

describe('pending-note', () => {
  beforeEach(() => {
    resetPendingNotesForTests();
  });

  it('queues and drains also notes for the active run', () => {
    setActiveAlsoRun('s1', 10);
    queueAlsoNote('s1', { text: 'first', runId: 10, messageId: 'm1' });
    queueAlsoNote('s1', { text: 'second', runId: 10, messageId: 'm2' });

    const drained = drainAlsoNotesForRun('s1', 10);
    expect(drained).toHaveLength(2);
    expect(drainAlsoNotesForRun('s1', 10)).toHaveLength(0);
  });

  it('drainAlsoNotesForRun ignores notes bound to a different run', () => {
    queueAlsoNote('s1', { text: 'use Chinese', runId: 10, messageId: 'm1' });
    expect(drainAlsoNotesForRun('s1', 11)).toHaveLength(0);
    expect(drainAlsoNotesForRun('s1', 10)).toHaveLength(1);
  });

  it('appendQueuedAlsoNotesToMessages appends plain user messages into canonical history', () => {
    setActiveAlsoRun('s1', 10);
    queueAlsoNote('s1', { text: '用中文思考', runId: 10, messageId: 'm1' });
    const base = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'old task' },
      { role: 'assistant' as const, content: 'old answer' },
    ];
    const drained = appendQueuedAlsoNotesToMessages(base, 's1');

    expect(drained).toHaveLength(1);
    expect(base).toHaveLength(4);
    expect(base[3]).toMatchObject({
      role: 'user',
      content: '用中文思考',
      preserveOnCompaction: true,
      alsoNote: true,
    });
  });

  it('appendQueuedAlsoNotesToMessages appends after tool results in a mid-run turn', () => {
    setActiveAlsoRun('s1', 10);
    queueAlsoNote('s1', { text: '本轮必须用中文回答', runId: 10, messageId: 'm1' });
    const base = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: '找出项目里的 BUG' },
      { role: 'assistant' as const, content: 'reading files' },
      { role: 'tool' as const, content: 'file contents' },
    ];
    appendQueuedAlsoNotesToMessages(base, 's1');

    expect(base).toHaveLength(5);
    expect(base[4]).toMatchObject({
      role: 'user',
      content: '本轮必须用中文回答',
      alsoNote: true,
    });
  });

  it('clearPendingNoteForRun removes only notes for the matching run', () => {
    queueAlsoNote('s1', { text: 'run-10', runId: 10, messageId: 'm1' });
    queueAlsoNote('s1', { text: 'run-11', runId: 11, messageId: 'm2' });
    clearPendingNoteForRun('s1', 10);
    expect(drainAlsoNotesForRun('s1', 11)).toHaveLength(1);
    expect(drainAlsoNotesForRun('s1', 11)).toHaveLength(0);
  });

  it('clearPendingNotesForSession clears queued notes and active run binding', () => {
    setActiveAlsoRun('s1', 10);
    queueAlsoNote('s1', { text: 'x', runId: 10, messageId: 'm1' });
    clearPendingNotesForSession('s1');
    expect(drainAlsoNotesForRun('s1', 10)).toHaveLength(0);
    expect(appendQueuedAlsoNotesToMessages([], 's1')).toHaveLength(0);
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
