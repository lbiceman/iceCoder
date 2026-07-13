import type { UnifiedMessage } from '../llm/types.js';

const pendingNoteBySession = new Map<string, string>();

export const PENDING_NOTE_DISCARD_MESSAGE = '任务已结束，备注未生效';
export const PENDING_NOTE_SUCCESS_MESSAGE = '📝 已记录备注，下次对话时自动带上';
export const PENDING_NOTE_USAGE_MESSAGE = '用法: /also <补充说明>';

export function formatPendingNoteSuccessMessage(text: string): string {
  return `${PENDING_NOTE_SUCCESS_MESSAGE}\n\n${text}`;
}

export function formatPendingNoteForHarnessContext(text: string): string {
  return [
    'The user provided the following note for this turn. Treat it as a high-priority instruction for the current task, above ordinary conversation history.',
    'Apply it to all reasoning, tool-use narration, and final response for this turn unless it conflicts with system/developer/tool safety constraints.',
    '',
    text,
  ].join('\n');
}

export function injectPendingNoteForTurn(
  messages: UnifiedMessage[],
  text: string | undefined,
): UnifiedMessage[] {
  if (!text?.trim()) return messages;
  const noteMessage: UnifiedMessage = {
    role: 'user',
    content: `# pending_note_for_this_turn\n${formatPendingNoteForHarnessContext(text.trim())}`,
  };
  const lastUserIndex = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return i;
    }
    return -1;
  })();
  if (lastUserIndex < 0) return [...messages, noteMessage];
  return [
    ...messages.slice(0, lastUserIndex),
    noteMessage,
    ...messages.slice(lastUserIndex),
  ];
}

export function setPendingNote(sessionId: string, text: string): void {
  pendingNoteBySession.set(sessionId, text);
}

export function getPendingNote(sessionId: string): string | undefined {
  return pendingNoteBySession.get(sessionId);
}

export function clearPendingNote(sessionId: string): void {
  pendingNoteBySession.delete(sessionId);
}

export function hasPendingNote(sessionId: string): boolean {
  return pendingNoteBySession.has(sessionId);
}

export function parseAlsoCommand(content: string): { matched: boolean; text: string } {
  const trimmed = content.trim();
  if (trimmed.startsWith('/also')) {
    return { matched: true, text: trimmed.slice('/also'.length).trim() };
  }
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (t.startsWith('/also')) {
      return { matched: true, text: t.slice('/also'.length).trim() };
    }
  }
  return { matched: false, text: '' };
}

export function parseNextCommand(content: string): { matched: boolean; text: string } {
  const trimmed = content.trim();
  if (trimmed.startsWith('/next')) {
    return { matched: true, text: trimmed.slice('/next'.length).trim() };
  }
  for (const line of trimmed.split('\n')) {
    const t = line.trim();
    if (t.startsWith('/next')) {
      return { matched: true, text: t.slice('/next'.length).trim() };
    }
  }
  return { matched: false, text: '' };
}

export function injectPendingNote(
  messages: UnifiedMessage[],
  sessionId: string,
): UnifiedMessage[] {
  const note = pendingNoteBySession.get(sessionId);
  if (!note) return messages;
  pendingNoteBySession.delete(sessionId);
  return [
    ...messages,
    { role: 'user', content: `[备注] ${note}` },
  ];
}

export function discardPendingNoteIfUnused(sessionId: string): string | undefined {
  if (!pendingNoteBySession.has(sessionId)) return undefined;
  pendingNoteBySession.delete(sessionId);
  return PENDING_NOTE_DISCARD_MESSAGE;
}

export function clearPendingNotesForSession(sessionId: string): void {
  pendingNoteBySession.delete(sessionId);
}

export function resetPendingNotesForTests(): void {
  pendingNoteBySession.clear();
}
