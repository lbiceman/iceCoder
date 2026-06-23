/**
 * 从用户消息起截断 UI / 结构化对话（不回滚工作区）。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UnifiedMessage } from '../llm/types.js';
import type { UiChatMessage } from '../types/intent-checkpoint.js';
import { readUiSessionMessages, writeUiSessionMessages } from './intent-checkpoint-capture.js';
import { truncateCheckpointsFrom } from './intent-checkpoint-store.js';

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

export function truncateUiMessagesBeforeUserMessage(
  uiMessages: UiChatMessage[],
  messageId: string,
): UiChatMessage[] | null {
  const idx = uiMessages.findIndex((m) => m.id === messageId && m.role === 'user');
  if (idx < 0) return null;
  return uiMessages.slice(0, idx);
}

export function truncateStructuredBeforeUserMessage(
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
        return structuredMessages.slice(0, i);
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

export async function deleteUserMessageConversation(
  params: DeleteUserMessageParams,
): Promise<{ deletedFromMessageId: string }> {
  const { sessionDir, sessionId, messageId } = params;
  const uiMessages = await readUiSessionMessages(sessionDir, sessionId);
  const truncatedUi = truncateUiMessagesBeforeUserMessage(uiMessages, messageId);
  if (!truncatedUi) {
    throw new DeleteMessageNotFoundError('未找到该用户消息。');
  }

  const cached = params.getStructuredMessages?.();
  const structured = (cached && cached.length > 0)
    ? cached
    : await readStructuredMessages(sessionDir, sessionId);
  const truncatedStructured = truncateStructuredBeforeUserMessage(structured, uiMessages, messageId) ?? [];

  await writeUiSessionMessages(sessionDir, sessionId, truncatedUi);
  await writeStructuredMessages(sessionDir, sessionId, truncatedStructured);
  params.setStructuredMessages?.(truncatedStructured.length > 0 ? truncatedStructured : undefined);
  await truncateCheckpointsFrom(sessionDir, sessionId, messageId);

  return { deletedFromMessageId: messageId };
}
