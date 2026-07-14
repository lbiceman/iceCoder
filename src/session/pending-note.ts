import type { UnifiedMessage } from '../llm/types.js';

export interface AlsoNoteEntry {
  text: string;
  runId: number;
  messageId: string;
}

const pendingAlsoNotesBySession = new Map<string, AlsoNoteEntry[]>();
const activeAlsoRunIdBySession = new Map<string, number>();

export const PENDING_NOTE_USAGE_MESSAGE = '用法: /also <补充说明>';

function buildAlsoNoteUserMessage(text: string): UnifiedMessage {
  return {
    role: 'user',
    content: text.trim(),
    preserveOnCompaction: true,
    alsoNote: true,
  };
}

export function setActiveAlsoRun(sessionId: string, runId: number): void {
  activeAlsoRunIdBySession.set(sessionId, runId);
}

export function queueAlsoNote(sessionId: string, entry: AlsoNoteEntry): void {
  const list = pendingAlsoNotesBySession.get(sessionId) ?? [];
  list.push(entry);
  pendingAlsoNotesBySession.set(sessionId, list);
}

export function drainAlsoNotesForRun(sessionId: string, runId?: number): AlsoNoteEntry[] {
  const list = pendingAlsoNotesBySession.get(sessionId) ?? [];
  if (list.length === 0) return [];
  const kept: AlsoNoteEntry[] = [];
  const drained: AlsoNoteEntry[] = [];
  for (const entry of list) {
    if (runId != null && entry.runId !== runId) {
      kept.push(entry);
    } else {
      drained.push(entry);
    }
  }
  if (kept.length > 0) pendingAlsoNotesBySession.set(sessionId, kept);
  else pendingAlsoNotesBySession.delete(sessionId);
  return drained;
}

/** 将排队备注写入 canonical 消息列表，与主任务 user 消息同等对待。 */
export function appendQueuedAlsoNotesToMessages(
  messages: UnifiedMessage[],
  sessionId: string,
): AlsoNoteEntry[] {
  const runId = activeAlsoRunIdBySession.get(sessionId);
  const drained = drainAlsoNotesForRun(sessionId, runId);
  for (const entry of drained) {
    messages.push(buildAlsoNoteUserMessage(entry.text));
  }
  return drained;
}

export function clearPendingNoteForRun(sessionId: string, runId: number): void {
  const list = pendingAlsoNotesBySession.get(sessionId) ?? [];
  const kept = list.filter((entry) => entry.runId !== runId);
  if (kept.length > 0) pendingAlsoNotesBySession.set(sessionId, kept);
  else pendingAlsoNotesBySession.delete(sessionId);
  if (activeAlsoRunIdBySession.get(sessionId) === runId) {
    activeAlsoRunIdBySession.delete(sessionId);
  }
}

export function clearPendingNotesForSession(sessionId: string): void {
  pendingAlsoNotesBySession.delete(sessionId);
  activeAlsoRunIdBySession.delete(sessionId);
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

export function resetPendingNotesForTests(): void {
  pendingAlsoNotesBySession.clear();
  activeAlsoRunIdBySession.clear();
}
