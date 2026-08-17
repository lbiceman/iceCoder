/**
 * 从 UI / 结构化对话中删除单条用户消息（不回滚工作区）。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UnifiedMessage } from '../llm/types.js';
import type { UiChatMessage } from '../types/intent-checkpoint.js';
import {
  extractUserMessageText,
  isAlsoNoteMessage,
  isSystemInjectedUserContent,
} from './harness-message-utils.js';
import { readUiSessionMessages, writeUiSessionMessages } from './intent-checkpoint-capture.js';
import {
  loadCheckpointIndex,
  loadIntentCheckpoint,
  removeCheckpoint,
  rewriteIntentCheckpoint,
} from './intent-checkpoint-store.js';
import { removeToolTraceDiffEntries } from '../web/session-tool-trace-diffs.js';

function isAlsoNoteUiMessage(message: UiChatMessage): boolean {
  return message.role === 'user' && message.alsoNote === true;
}

function isRealUiUserMessage(message: UiChatMessage): boolean {
  if (message.role !== 'user') return false;
  if (isAlsoNoteUiMessage(message)) return false;
  const content = typeof message.content === 'string' ? message.content : '';
  return content.trim().length > 0;
}

function isRealStructuredUserMessage(message: UnifiedMessage): boolean {
  if (message.role !== 'user') return false;
  if (isAlsoNoteMessage(message)) return false;
  const text = extractUserMessageText(message.content ?? '');
  if (!text.trim()) return false;
  return !isSystemInjectedUserContent(text);
}

function findSkillGuideIndexForDeletedRequest(
  structuredMessages: UnifiedMessage[],
  deletedUserContent: string,
): number {
  const needle = deletedUserContent.trim();
  if (!needle) return -1;
  return structuredMessages.findIndex((message) => {
    if (message.role !== 'user' || typeof message.content !== 'string') return false;
    return message.content.includes('[System: Skill File Guide]')
      && message.content.includes(needle);
  });
}

function findNextUiUserIndex(uiMessages: UiChatMessage[], afterIdx: number): number {
  for (let i = afterIdx + 1; i < uiMessages.length; i++) {
    if (uiMessages[i].role === 'user') return i;
  }
  return -1;
}

function findNextRealUiUserIndex(uiMessages: UiChatMessage[], afterIdx: number): number {
  for (let i = afterIdx + 1; i < uiMessages.length; i++) {
    if (isRealUiUserMessage(uiMessages[i])) return i;
  }
  return -1;
}

function uiUserContent(message: UiChatMessage | undefined): string {
  return typeof message?.content === 'string' ? message.content : '';
}

function findStructuredStartForUiUser(
  structuredMessages: UnifiedMessage[],
  uiMessages: UiChatMessage[],
  uiIdx: number,
  anchorUserContent = '',
): number {
  let realUiBefore = 0;
  for (let i = 0; i < uiIdx; i++) {
    if (isRealUiUserMessage(uiMessages[i])) realUiBefore++;
  }

  let start = findNthRealStructuredUserIndex(structuredMessages, realUiBefore);
  if (start < 0 && anchorUserContent) {
    start = findSkillGuideIndexForDeletedRequest(structuredMessages, anchorUserContent);
  }
  return start;
}

function findDeletedStructuredRange(
  structuredMessages: UnifiedMessage[],
  uiMessages: UiChatMessage[],
  messageId: string,
  deletedUserContent: string,
): { start: number; end: number } | null {
  const uiIdx = uiMessages.findIndex((m) => m.id === messageId && m.role === 'user');
  if (uiIdx < 0) return null;

  const start = findStructuredStartForUiUser(
    structuredMessages,
    uiMessages,
    uiIdx,
    deletedUserContent,
  );
  if (start < 0) return null;

  const nextRealUiUserIdx = findNextRealUiUserIndex(uiMessages, uiIdx);
  let end = structuredMessages.length;
  if (nextRealUiUserIdx >= 0) {
    const nextStart = findStructuredStartForUiUser(
      structuredMessages,
      uiMessages,
      nextRealUiUserIdx,
      uiUserContent(uiMessages[nextRealUiUserIdx]),
    );
    if (nextStart >= 0) end = nextStart;
  }

  return { start, end };
}

function findNthRealStructuredUserIndex(
  structuredMessages: UnifiedMessage[],
  targetIndex: number,
): number {
  if (targetIndex < 0) return -1;
  let seen = 0;
  for (let i = 0; i < structuredMessages.length; i++) {
    if (!isRealStructuredUserMessage(structuredMessages[i])) continue;
    if (seen === targetIndex) return i;
    seen++;
  }
  return -1;
}

function findNthAlsoNoteStructuredIndex(
  structuredMessages: UnifiedMessage[],
  targetIndex: number,
): number {
  if (targetIndex < 0) return -1;
  let seen = 0;
  for (let i = 0; i < structuredMessages.length; i++) {
    if (!isAlsoNoteMessage(structuredMessages[i])) continue;
    if (seen === targetIndex) return i;
    seen++;
  }
  return -1;
}

function removeStructuredAlsoNote(
  structuredMessages: UnifiedMessage[],
  uiMessages: UiChatMessage[],
  uiIdx: number,
): UnifiedMessage[] {
  let alsoBefore = 0;
  for (let i = 0; i < uiIdx; i++) {
    if (isAlsoNoteUiMessage(uiMessages[i])) alsoBefore++;
  }

  const removeIdx = findNthAlsoNoteStructuredIndex(structuredMessages, alsoBefore);
  if (removeIdx < 0) return structuredMessages;

  return [
    ...structuredMessages.slice(0, removeIdx),
    ...structuredMessages.slice(removeIdx + 1),
  ];
}

function collectToolCallIdsFromUiMessages(messages: UiChatMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.role === 'tool_trace' && message.toolCallId) {
      ids.push(message.toolCallId);
    }
  }
  return ids;
}

function stripResumeCheckpointMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  return messages.filter((message) => {
    if (message.role !== 'user' || typeof message.content !== 'string') return true;
    return !message.content.trim().startsWith('<resume-checkpoint>');
  });
}

async function clearActiveTaskCheckpoint(sessionDir: string, sessionId: string): Promise<void> {
  await fs.unlink(path.join(sessionDir, `${sessionId}.checkpoint.json`)).catch(() => {});
}

async function readStructuredMessages(
  sessionDir: string,
  sessionId: string,
): Promise<UnifiedMessage[]> {
  const file = path.join(sessionDir, `${sessionId}.structured.json`);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as UnifiedMessage[] : [];
  } catch {
    return [];
  }
}

async function writeStructuredMessages(
  sessionDir: string,
  sessionId: string,
  messages: UnifiedMessage[],
): Promise<void> {
  const file = path.join(sessionDir, `${sessionId}.structured.json`);
  await fs.mkdir(sessionDir, { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(messages), 'utf-8');
  await fs.rename(tmp, file);
}

export class DeleteMessageNotFoundError extends Error {
  readonly code = 'DELETE_MESSAGE_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'DeleteMessageNotFoundError';
  }
}

export function removeUiUserMessage(
  uiMessages: UiChatMessage[],
  messageId: string,
): UiChatMessage[] | null {
  const idx = uiMessages.findIndex((m) => m.id === messageId && m.role === 'user');
  if (idx < 0) return null;

  if (isAlsoNoteUiMessage(uiMessages[idx])) {
    return [...uiMessages.slice(0, idx), ...uiMessages.slice(idx + 1)];
  }

  const nextUiUserIdx = findNextUiUserIndex(uiMessages, idx);
  const end = nextUiUserIdx >= 0 ? nextUiUserIdx : uiMessages.length;
  return [...uiMessages.slice(0, idx), ...uiMessages.slice(end)];
}

export function removeStructuredUserMessage(
  structuredMessages: UnifiedMessage[],
  uiMessages: UiChatMessage[],
  messageId: string,
  deletedUserContent = '',
): UnifiedMessage[] | null {
  const uiIdx = uiMessages.findIndex((m) => m.id === messageId && m.role === 'user');
  if (uiIdx < 0) return null;

  if (isAlsoNoteUiMessage(uiMessages[uiIdx])) {
    return stripResumeCheckpointMessages(
      removeStructuredAlsoNote(structuredMessages, uiMessages, uiIdx),
    );
  }

  const range = findDeletedStructuredRange(
    structuredMessages,
    uiMessages,
    messageId,
    deletedUserContent,
  );
  if (!range) {
    return stripResumeCheckpointMessages(structuredMessages);
  }

  return stripResumeCheckpointMessages([
    ...structuredMessages.slice(0, range.start),
    ...structuredMessages.slice(range.end),
  ]);
}

export interface DeleteUserMessageParams {
  sessionDir: string;
  sessionId: string;
  messageId: string;
  getStructuredMessages?: () => UnifiedMessage[] | undefined;
  setStructuredMessages?: (messages: UnifiedMessage[] | undefined) => void;
}

async function removeMessageFromCheckpointHistory(
  sessionDir: string,
  sessionId: string,
  messageId: string,
  deletedUserContent = '',
): Promise<void> {
  const index = await loadCheckpointIndex(sessionDir, sessionId);
  const targetIdx = index.entries.findIndex((entry) => entry.messageId === messageId);
  if (targetIdx < 0) return;

  for (const entry of index.entries.slice(targetIdx + 1)) {
    const archive = await loadIntentCheckpoint(sessionDir, sessionId, entry.messageId);
    if (!archive) continue;
    const nextStructured = removeStructuredUserMessage(
      archive.structuredMessages,
      archive.uiMessages,
      messageId,
      deletedUserContent,
    );
    const nextUi = removeUiUserMessage(archive.uiMessages, messageId);
    if (!nextUi) continue;
    await rewriteIntentCheckpoint(sessionDir, sessionId, {
      ...archive,
      uiMessages: nextUi,
      structuredMessages: nextStructured ?? archive.structuredMessages,
    });
  }

  await removeCheckpoint(sessionDir, sessionId, messageId);
}

export async function deleteUserMessageConversation(
  params: DeleteUserMessageParams,
): Promise<{
  deletedMessageId: string;
  deletedUserContent: string;
  firstRemainingUserContent: string | null;
  remainingUserCount: number;
}> {
  const { sessionDir, sessionId, messageId } = params;
  const uiMessages = await readUiSessionMessages(sessionDir, sessionId);
  const deletedMessage = uiMessages.find((message) =>
    message.id === messageId && message.role === 'user');
  const deleteIdx = uiMessages.findIndex((message) =>
    message.id === messageId && message.role === 'user');
  if (deleteIdx < 0 || !deletedMessage) {
    throw new DeleteMessageNotFoundError('未找到该用户消息。');
  }

  const nextUiUserIdx = findNextUiUserIndex(uiMessages, deleteIdx);
  const removedUiMessages = isAlsoNoteUiMessage(deletedMessage)
    ? [deletedMessage]
    : uiMessages.slice(deleteIdx, nextUiUserIdx >= 0 ? nextUiUserIdx : uiMessages.length);

  const nextUi = removeUiUserMessage(uiMessages, messageId);
  if (!nextUi) {
    throw new DeleteMessageNotFoundError('未找到该用户消息。');
  }

  const cached = params.getStructuredMessages?.();
  const structured = (cached && cached.length > 0)
    ? cached
    : await readStructuredMessages(sessionDir, sessionId);
  const deletedUserContent = typeof deletedMessage.content === 'string' ? deletedMessage.content : '';
  const nextStructured = removeStructuredUserMessage(
    structured,
    uiMessages,
    messageId,
    deletedUserContent,
  ) ?? structured;

  await writeUiSessionMessages(sessionDir, sessionId, nextUi);
  await writeStructuredMessages(sessionDir, sessionId, nextStructured);
  params.setStructuredMessages?.(nextStructured.length > 0 ? nextStructured : undefined);
  await removeToolTraceDiffEntries(
    sessionDir,
    sessionId,
    collectToolCallIdsFromUiMessages(removedUiMessages),
  );
  await removeMessageFromCheckpointHistory(sessionDir, sessionId, messageId, deletedUserContent);
  await clearActiveTaskCheckpoint(sessionDir, sessionId);

  const remainingUsers = nextUi.filter((message) => isRealUiUserMessage(message));
  const firstRemainingContent = remainingUsers.find((message) =>
    typeof message.content === 'string' && message.content.trim());
  return {
    deletedMessageId: messageId,
    deletedUserContent,
    firstRemainingUserContent:
      typeof firstRemainingContent?.content === 'string' ? firstRemainingContent.content : null,
    remainingUserCount: remainingUsers.length,
  };
}
