import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  deleteUserMessageConversation,
  removeStructuredUserMessage,
  removeUiUserMessage,
  scrubSessionNotesRuntimeAfterDelete,
  truncateConversationBeforeUserMessage,
} from '../../src/harness/conversation-delete.js';
import {
  bumpSessionContextWriteEpoch,
  isSessionContextWriteStale,
  resetSessionContextWriteEpoch,
  sessionContextWriteEpoch,
} from '../../src/harness/session-context-write-gate.js';
import {
  parsePersistedRuntime,
  serializePersistedRuntime,
} from '../../src/memory/file-memory/session-memory.js';
import {
  loadCheckpointIndex,
  loadIntentCheckpoint,
  saveIntentCheckpoint,
} from '../../src/harness/intent-checkpoint-store.js';
import { persistToolTraceDiff, readToolTraceDiffIndex } from '../../src/web/session-tool-trace-diffs.js';
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

  it('removeUiUserMessage removes the target user message and its agent reply', () => {
    expect(removeUiUserMessage(uiMessages, 'u2')).toEqual([
      uiMessages[0],
      uiMessages[1],
      uiMessages[4],
    ]);
    expect(removeUiUserMessage(uiMessages, 'u3')).toEqual(uiMessages.slice(0, 4));
  });

  it('removeUiUserMessage returns null when missing', () => {
    expect(removeUiUserMessage(uiMessages, 'missing')).toBeNull();
  });

  it('removeStructuredUserMessage removes the aligned user turn and assistant reply', () => {
    expect(removeStructuredUserMessage(structuredMessages, uiMessages, 'u2')).toEqual([
      structuredMessages[0],
      structuredMessages[1],
      structuredMessages[4],
    ]);
    expect(removeStructuredUserMessage(structuredMessages, uiMessages, 'u3')).toEqual(
      structuredMessages.slice(0, 4),
    );
  });

  it('truncateConversationBeforeUserMessage drops the target turn and everything after', () => {
    expect(truncateConversationBeforeUserMessage(uiMessages, structuredMessages, 'u2')).toEqual({
      uiMessages: uiMessages.slice(0, 2),
      structuredMessages: structuredMessages.slice(0, 2),
    });
  });

  it('truncates structured context by archived user text when the live id is missing', () => {
    expect(truncateConversationBeforeUserMessage(
      uiMessages.map((m) => (m.id === 'u2' ? { ...m, id: 'optimistic-u2' } : m)),
      structuredMessages,
      'u2',
      'image turn',
    )).toEqual({
      uiMessages: uiMessages.map((m) => (m.id === 'u2' ? { ...m, id: 'optimistic-u2' } : m)),
      structuredMessages: structuredMessages.slice(0, 2),
    });
  });

  it('deletes a turn whose structured text has a workspace path prefix', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-delete-prefix-'));
    const sessionId = 'prefix-delete';
    const ui: UiChatMessage[] = [
      { role: 'user', id: 'u1', content: '随便新增一个空文件' },
      { role: 'system', id: 'sys1', content: '已回滚至检查点' },
    ];
    const structured: UnifiedMessage[] = [
      { role: 'user', content: 'E:\\test\\agentToolTest\\20260910\n\n随便新增一个空文件' },
    ];
    try {
      await fs.writeFile(path.join(sessionDir, `${sessionId}.json`), JSON.stringify(ui), 'utf-8');
      await fs.writeFile(
        path.join(sessionDir, `${sessionId}.structured.json`),
        JSON.stringify(structured),
        'utf-8',
      );
      await deleteUserMessageConversation({ sessionDir, sessionId, messageId: 'u1' });
      const savedUi = JSON.parse(
        await fs.readFile(path.join(sessionDir, `${sessionId}.json`), 'utf-8'),
      ) as UiChatMessage[];
      const savedStructured = JSON.parse(
        await fs.readFile(path.join(sessionDir, `${sessionId}.structured.json`), 'utf-8'),
      ) as UnifiedMessage[];
      expect(savedUi.map((message) => message.id)).toEqual(['sys1']);
      expect(savedStructured).toEqual([]);
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('removeStructuredUserMessage keeps later turns when deleting before a skill guide turn', () => {
    const uiWithSkill: UiChatMessage[] = [
      { role: 'user', id: 'u1', content: 'hello' },
      { role: 'agent', id: 'a1', content: 'hi' },
      { role: 'user', id: 'u2', content: 'create skill please' },
      { role: 'agent', id: 'a2', content: 'drafting skill' },
    ];
    const structuredWithSkill: UnifiedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '[System: Skill File Guide]\n[User Request]\ncreate skill please' },
      { role: 'assistant', content: 'drafting skill' },
    ];

    expect(removeStructuredUserMessage(
      structuredWithSkill,
      uiWithSkill,
      'u1',
      'hello',
    )).toEqual([
      structuredWithSkill[2],
      structuredWithSkill[3],
    ]);
  });

  it('removeStructuredUserMessage skips system-injected user blocks when aligning turns', () => {
    const uiWithSkill: UiChatMessage[] = [
      { role: 'user', id: 'u1', content: 'hello' },
      { role: 'agent', id: 'a1', content: 'hi' },
      { role: 'user', id: 'u2', content: 'create skill please' },
    ];
    const structuredWithSkill: UnifiedMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '[System: Skill File Guide]\n[User Request]\ncreate skill please' },
      { role: 'assistant', content: 'drafting skill' },
    ];

    expect(removeStructuredUserMessage(
      structuredWithSkill,
      uiWithSkill,
      'u2',
      'create skill please',
    )).toEqual([
      structuredWithSkill[0],
      structuredWithSkill[1],
    ]);
  });

  it('removeUiUserMessage deletes only an /also note without cascading', () => {
    const uiWithAlso: UiChatMessage[] = [
      { role: 'user', id: 'u1', content: 'hello' },
      { role: 'agent', id: 'a1', content: 'hi' },
      { role: 'user', id: 'also1', content: 'fix tests only', alsoNote: true },
      { role: 'user', id: 'u2', content: 'next task' },
      { role: 'agent', id: 'a2', content: 'done' },
    ];

    expect(removeUiUserMessage(uiWithAlso, 'also1')).toEqual([
      uiWithAlso[0],
      uiWithAlso[1],
      uiWithAlso[3],
      uiWithAlso[4],
    ]);
  });

  it('removeStructuredUserMessage aligns turns when UI has /also notes absent from structured', () => {
    const uiWithAlso: UiChatMessage[] = [
      { role: 'user', id: 'u1', content: 'first' },
      { role: 'agent', id: 'a1', content: 'answer one' },
      { role: 'user', id: 'also1', content: 'fix tests only', alsoNote: true },
      { role: 'user', id: 'u2', content: 'delete me' },
      { role: 'agent', id: 'a2', content: 'answer two' },
    ];
    const structured: UnifiedMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'delete me' },
      { role: 'assistant', content: 'answer two' },
    ];

    expect(removeStructuredUserMessage(structured, uiWithAlso, 'u2', 'delete me')).toEqual([
      structured[0],
      structured[1],
    ]);
  });

  it('removeStructuredUserMessage removes aligned /also note from structured history', () => {
    const uiWithAlso: UiChatMessage[] = [
      { role: 'user', id: 'u1', content: 'first' },
      { role: 'user', id: 'also1', content: 'fix tests only', alsoNote: true },
    ];
    const structured: UnifiedMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'fix tests only', alsoNote: true },
    ];

    expect(removeStructuredUserMessage(structured, uiWithAlso, 'also1')).toEqual([
      structured[0],
      structured[1],
    ]);
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
      await fs.writeFile(
        path.join(sessionDir, `${sessionId}.checkpoint.json`),
        JSON.stringify({ version: 1, status: 'paused', userGoal: 'create skill please' }),
        'utf-8',
      );

      await deleteUserMessageConversation({ sessionDir, sessionId, messageId: 'u2' });

      await expect(fs.access(path.join(sessionDir, `${sessionId}.checkpoint.json`))).rejects.toThrow();

      const savedUi = JSON.parse(
        await fs.readFile(path.join(sessionDir, `${sessionId}.json`), 'utf-8'),
      ) as UiChatMessage[];
      const savedStructured = JSON.parse(
        await fs.readFile(path.join(sessionDir, `${sessionId}.structured.json`), 'utf-8'),
      ) as UnifiedMessage[];
      const index = await loadCheckpointIndex(sessionDir, sessionId);
      const laterArchive = await loadIntentCheckpoint(sessionDir, sessionId, 'u3');

      expect(savedUi.map((message) => message.id)).toEqual(['u1', 'a1', 'u3']);
      expect(savedStructured.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
      ]);
      expect(index.entries.map((entry) => entry.messageId)).toEqual(['u1', 'u3']);
      expect(index.cursorMessageId).toBe('u3');
      expect(await loadIntentCheckpoint(sessionDir, sessionId, 'u2')).toBeNull();
      expect(laterArchive?.uiMessages.map((message) => message.id)).toEqual([
        'u1',
        'a1',
        'u3',
      ]);
      expect(laterArchive?.structuredMessages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
      ]);
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('deleteUserMessageConversation removes tool trace diff entries for deleted turn', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-delete-diff-'));
    const sessionId = 'delete-diff';
    const uiWithTrace: UiChatMessage[] = [
      { role: 'user', id: 'u1', content: 'write file' },
      { role: 'tool_trace', parentId: 'a1', toolName: 'write_file', detail: 'a.ts', toolCallId: 'call_1' },
      { role: 'agent', id: 'a1', content: 'done' },
      { role: 'user', id: 'u2', content: 'keep me' },
    ];
    const structured: UnifiedMessage[] = [
      { role: 'user', content: 'write file' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'keep me' },
    ];

    try {
      await fs.writeFile(path.join(sessionDir, `${sessionId}.json`), JSON.stringify(uiWithTrace), 'utf-8');
      await fs.writeFile(
        path.join(sessionDir, `${sessionId}.structured.json`),
        JSON.stringify(structured),
        'utf-8',
      );
      await persistToolTraceDiff(sessionDir, sessionId, 'call_1', '--- a\n+++ b\n@@\n+x');
      await persistToolTraceDiff(sessionDir, sessionId, 'call_keep', '--- c\n+++ d\n@@\n+y');

      await deleteUserMessageConversation({ sessionDir, sessionId, messageId: 'u1' });

      const savedUi = JSON.parse(
        await fs.readFile(path.join(sessionDir, `${sessionId}.json`), 'utf-8'),
      ) as UiChatMessage[];
      const index = await readToolTraceDiffIndex(sessionDir, sessionId);

      expect(savedUi.map((message) => message.id)).toEqual(['u2']);
      expect(index.call_1).toBeUndefined();
      expect(index.call_keep).toContain('+y');
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('scrubs deleted-turn write paths from session-notes runtime evidence', () => {
    const notes = [
      '# Session Title',
      'demo',
      '',
      '# Runtime Evidence (auto)',
      '_auto_',
      '',
      '```icecoder-runtime',
      serializePersistedRuntime(
        {
          goal: '写文件',
          intent: 'edit',
          phase: 'editing',
          filesRead: [],
          filesChanged: ['empty.txt', '1.txt'],
          commandsRun: [],
        },
        {
          filesRead: [],
          filesChanged: ['empty.txt', '1.txt'],
          commandsRun: [],
          testCommands: [],
          recentDiagnostics: [],
        },
      ),
      '```',
      '',
      '# Worklog',
      'wrote files',
    ].join('\n');

    const next = scrubSessionNotesRuntimeAfterDelete(notes, ['1.txt']);
    const parsed = parsePersistedRuntime(next);
    expect(parsed?.task.filesChanged).toEqual(['empty.txt']);
    expect(parsed?.repo.filesChanged).toEqual(['empty.txt']);
  });

  it('invalidates in-flight session-notes writes after a message is deleted', async () => {
    resetSessionContextWriteEpoch();
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-delete-notes-'));
    const sessionId = 'notes-delete';
    const epochBefore = sessionContextWriteEpoch(sessionId);
    try {
      await fs.writeFile(
        path.join(sessionDir, `${sessionId}.json`),
        JSON.stringify([
          { role: 'user', id: 'u1', content: '新建 1.txt' },
          {
            role: 'tool_trace',
            toolName: 'write_file',
            detail: '1.txt',
            status: 'success',
            toolCallId: 'call-1',
          },
        ]),
        'utf-8',
      );
      await fs.writeFile(
        path.join(sessionDir, `${sessionId}.structured.json`),
        JSON.stringify([{ role: 'user', content: '新建 1.txt' }]),
        'utf-8',
      );
      await fs.writeFile(
        path.join(sessionDir, `${sessionId}.session-notes.md`),
        [
          '# Session Title',
          'demo',
          '',
          '# Runtime Evidence (auto)',
          '_auto_',
          '',
          '```icecoder-runtime',
          serializePersistedRuntime(
            {
              goal: '新建 1.txt',
              intent: 'edit',
              phase: 'editing',
              filesRead: [],
              filesChanged: ['1.txt'],
              commandsRun: [],
            },
            {
              filesRead: [],
              filesChanged: ['1.txt'],
              commandsRun: [],
              testCommands: [],
              recentDiagnostics: [],
            },
          ),
          '```',
        ].join('\n'),
        'utf-8',
      );

      await deleteUserMessageConversation({ sessionDir, sessionId, messageId: 'u1' });

      const notes = await fs.readFile(path.join(sessionDir, `${sessionId}.session-notes.md`), 'utf-8');
      expect(parsePersistedRuntime(notes)?.task.filesChanged).toEqual([]);
      expect(sessionContextWriteEpoch(sessionId)).toBeGreaterThan(epochBefore);
      expect(isSessionContextWriteStale(sessionId, epochBefore)).toBe(true);
    } finally {
      resetSessionContextWriteEpoch(sessionId);
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });
});

describe('session-context-write-gate', () => {
  it('marks captured epochs stale after bump', () => {
    resetSessionContextWriteEpoch('gate-s');
    const epoch = bumpSessionContextWriteEpoch('gate-s');
    expect(isSessionContextWriteStale('gate-s', epoch)).toBe(false);
    bumpSessionContextWriteEpoch('gate-s');
    expect(isSessionContextWriteStale('gate-s', epoch)).toBe(true);
    resetSessionContextWriteEpoch('gate-s');
  });
});
