import type { UnifiedMessage } from '../llm/types.js';

const pendingNoteBySession = new Map<string, string>();
const pendingNoteRunIdBySession = new Map<string, number>();

export const PENDING_NOTE_USAGE_MESSAGE = '用法: /also <补充说明>';

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

export function setPendingNote(sessionId: string, text: string, runId?: number): void {
  pendingNoteBySession.set(sessionId, text);
  if (runId != null) pendingNoteRunIdBySession.set(sessionId, runId);
  else pendingNoteRunIdBySession.delete(sessionId);
}

export function getPendingNote(sessionId: string): string | undefined {
  return pendingNoteBySession.get(sessionId);
}

export function clearPendingNote(sessionId: string): void {
  pendingNoteBySession.delete(sessionId);
  pendingNoteRunIdBySession.delete(sessionId);
}

export function consumePendingNote(sessionId: string, runId?: number): string | undefined {
  const noteRunId = pendingNoteRunIdBySession.get(sessionId);
  if (runId != null && noteRunId != null && noteRunId !== runId) return undefined;
  const note = pendingNoteBySession.get(sessionId);
  if (note) clearPendingNote(sessionId);
  return note;
}

export function clearPendingNoteForRun(sessionId: string, runId: number): void {
  if (pendingNoteRunIdBySession.get(sessionId) === runId) {
    clearPendingNote(sessionId);
  }
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
  clearPendingNote(sessionId);
  return [
    ...messages,
    { role: 'user', content: `[备注] ${note}` },
  ];
}

export function clearPendingNotesForSession(sessionId: string): void {
  pendingNoteBySession.delete(sessionId);
  pendingNoteRunIdBySession.delete(sessionId);
}

export function resetPendingNotesForTests(): void {
  pendingNoteBySession.clear();
  pendingNoteRunIdBySession.clear();
}
