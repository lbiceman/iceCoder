/**
 * 从 UI / 结构化对话中删除单条用户消息（不回滚工作区）。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UnifiedMessage } from '../llm/types.js';
import type { UiChatMessage } from '../types/intent-checkpoint.js';
import { readUiSessionMessages, writeUiSessionMessages } from './intent-checkpoint-capture.js';
import {
  loadCheckpointIndex,
  loadIntentCheckpoint,
  removeCheckpoint,
  rewriteIntentCheckpoint,
} from './intent-checkpoint-store.js';

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
  return [...uiMessages.slice(0, idx), ...uiMessages.slice(idx + 1)];
}

export function removeStructuredUserMessage(
  structuredMessages: UnifiedMessage[],
  uiMessages: UiChatMessage[],
  messageId: string,
): UnifiedMessage[] | null {
  const idx = uiMessages.findIndex((m) => m.id === messageId && m.role === 'user');
  if (idx < 0) return null;

  let userCountBefore = 0;
  for (let i = 0; i < idx; i++) {
    if (uiMessages[i].role === 'user') userCountBefore++;
  }

  let seenUsers = 0;
  for (let i = 0; i < structuredMessages.length; i++) {
    if (structuredMessages[i].role === 'user') {
      if (seenUsers === userCountBefore) {
        return [...structuredMessages.slice(0, i), ...structuredMessages.slice(i + 1)];
      }
      seenUsers++;
    }
  }

  return structuredMessages;
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
  const nextUi = removeUiUserMessage(uiMessages, messageId);
  if (!nextUi) {
    throw new DeleteMessageNotFoundError('未找到该用户消息。');
  }

  const cached = params.getStructuredMessages?.();
  const structured = (cached && cached.length > 0)
    ? cached
    : await readStructuredMessages(sessionDir, sessionId);
  const nextStructured = removeStructuredUserMessage(structured, uiMessages, messageId) ?? structured;

  await writeUiSessionMessages(sessionDir, sessionId, nextUi);
  await writeStructuredMessages(sessionDir, sessionId, nextStructured);
  params.setStructuredMessages?.(nextStructured.length > 0 ? nextStructured : undefined);
  await removeMessageFromCheckpointHistory(sessionDir, sessionId, messageId);

  const remainingUsers = nextUi.filter((message) => message.role === 'user');
  const firstRemainingContent = remainingUsers.find((message) =>
    typeof message.content === 'string' && message.content.trim());
  return {
    deletedMessageId: messageId,
    deletedUserContent: typeof deletedMessage?.content === 'string' ? deletedMessage.content : '',
    firstRemainingUserContent:
      typeof firstRemainingContent?.content === 'string' ? firstRemainingContent.content : null,
    remainingUserCount: remainingUsers.length,
  };
}
