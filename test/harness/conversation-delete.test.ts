import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  deleteUserMessageConversation,
  removeStructuredUserMessage,
  removeUiUserMessage,
} from '../../src/harness/conversation-delete.js';
import {
  loadCheckpointIndex,
  loadIntentCheckpoint,
  saveIntentCheckpoint,
} from '../../src/harness/intent-checkpoint-store.js';
import type { IntentCheckpointArchive } from '../../src/types/intent-checkpoint.js';
import type { UiChatMessage } from '../../src/types/intent-checkpoint.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

describe('conversation-delete', () => {
  const uiMessages: UiChatMessage[] = [
    { role: 'user', id: 'u1', content: 'hello' },
    { role: 'agent', id: 'a1', content: 'hi' },
    { role: 'user', id: 'u2', content: 'image turn', images: ['/api/sessions/x/images/1.png'] },
    { role: 'agent', id: 'a2', content: 'error' },
    { role: 'user', id: 'u3', content: 'retry' },
  ];

  const structuredMessages: UnifiedMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'image turn' },
        { type: 'image', imageUrl: 'data:image/png;base64,abc' },
      ],
    },
    { role: 'assistant', content: 'error' },
    { role: 'user', content: 'retry' },
  ];

  it('removeUiUserMessage removes only the target user message', () => {
    expect(removeUiUserMessage(uiMessages, 'u2')).toEqual([
      uiMessages[0],
      uiMessages[1],
      uiMessages[3],
      uiMessages[4],
    ]);
    expect(removeUiUserMessage(uiMessages, 'u3')).toEqual(uiMessages.slice(0, 4));
  });

  it('removeUiUserMessage returns null when missing', () => {
    expect(removeUiUserMessage(uiMessages, 'missing')).toBeNull();
  });

  it('removeStructuredUserMessage removes only the aligned structured user turn', () => {
    expect(removeStructuredUserMessage(structuredMessages, uiMessages, 'u2')).toEqual([
      structuredMessages[0],
      structuredMessages[1],
      structuredMessages[3],
      structuredMessages[4],
    ]);
    expect(removeStructuredUserMessage(structuredMessages, uiMessages, 'u3')).toEqual(
      structuredMessages.slice(0, 4),
    );
  });

  it('deletes only one message and scrubs it from later checkpoint snapshots', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-delete-one-'));
    const sessionId = 'single-delete';
    const makeArchive = (
      messageId: string,
      ui: UiChatMessage[],
      structured: UnifiedMessage[],
    ): IntentCheckpointArchive => ({
      version: 1,
      messageId,
      sessionId,
      createdAt: new Date().toISOString(),
      userMessageTime: null,
      combinedCheckpoint: null,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: sessionDir,
      workspaceFiles: {},
      trackedPaths: [],
      uiMessages: ui,
      structuredMessages: structured,
    });

    try {
      await fs.writeFile(
        path.join(sessionDir, `${sessionId}.json`),
        JSON.stringify(uiMessages),
        'utf-8',
      );
      await fs.writeFile(
        path.join(sessionDir, `${sessionId}.structured.json`),
        JSON.stringify(structuredMessages),
        'utf-8',
      );
      await saveIntentCheckpoint({
        sessionDir,
        sessionId,
        archive: makeArchive('u1', uiMessages.slice(0, 1), structuredMessages.slice(0, 1)),
      });
      await saveIntentCheckpoint({
        sessionDir,
        sessionId,
        archive: makeArchive('u2', uiMessages.slice(0, 3), structuredMessages.slice(0, 3)),
      });
      await saveIntentCheckpoint({
        sessionDir,
        sessionId,
        archive: makeArchive('u3', uiMessages, structuredMessages),
      });

      await deleteUserMessageConversation({ sessionDir, sessionId, messageId: 'u2' });

      const savedUi = JSON.parse(
        await fs.readFile(path.join(sessionDir, `${sessionId}.json`), 'utf-8'),
      ) as UiChatMessage[];
      const savedStructured = JSON.parse(
        await fs.readFile(path.join(sessionDir, `${sessionId}.structured.json`), 'utf-8'),
      ) as UnifiedMessage[];
      const index = await loadCheckpointIndex(sessionDir, sessionId);
      const laterArchive = await loadIntentCheckpoint(sessionDir, sessionId, 'u3');

      expect(savedUi.map((message) => message.id)).toEqual(['u1', 'a1', 'a2', 'u3']);
      expect(savedStructured.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'assistant',
        'user',
      ]);
      expect(index.entries.map((entry) => entry.messageId)).toEqual(['u1', 'u3']);
      expect(index.cursorMessageId).toBe('u3');
      expect(await loadIntentCheckpoint(sessionDir, sessionId, 'u2')).toBeNull();
      expect(laterArchive?.uiMessages.map((message) => message.id)).toEqual([
        'u1',
        'a1',
        'a2',
        'u3',
      ]);
      expect(laterArchive?.structuredMessages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'assistant',
        'user',
      ]);
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });
});
