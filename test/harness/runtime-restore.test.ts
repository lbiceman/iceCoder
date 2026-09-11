import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CheckpointEngine } from '../../src/harness/checkpoint-engine.js';
import { captureIntentCheckpoint } from '../../src/harness/intent-checkpoint-capture.js';
import {
  loadCheckpointIndex,
  loadIntentCheckpoint,
  rewriteIntentCheckpoint,
  touchSessionTouchedPaths,
} from '../../src/harness/intent-checkpoint-store.js';
import {
  beginSessionHarnessRun,
  resetHarnessRuntimeRegistry,
} from '../../src/harness/harness-runtime-registry.js';
import {
  RuntimeRestoreCoordinator,
  RestoreFailedError,
  RestoreNotAllowedError,
} from '../../src/harness/runtime-restore-coordinator.js';
import * as captureModule from '../../src/harness/intent-checkpoint-capture.js';
import {
  beginIntentCheckpointTurn,
  capturePreTurnWriteSnapshot,
  finalizeIntentCheckpointTurn,
  recordPreTurnMissingFile,
} from '../../src/harness/intent-checkpoint-turn-snapshot.js';
import { emptyRuntimeCheckpointV2 } from '../../src/types/runtime-checkpoint.js';
import { buildFileChangeDiff } from '../../src/tools/file-change-diff.js';
import {
  isSessionContextWriteStale,
  resetSessionContextWriteEpoch,
  sessionContextWriteEpoch,
} from '../../src/harness/session-context-write-gate.js';
import {
  parsePersistedRuntime,
  serializePersistedRuntime,
  sessionNotesPath,
} from '../../src/memory/file-memory/session-memory.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ice-restore-'));
}

async function seedEmptyThenTxtTurns(tmp: string, sessionId: string, locked: string) {
  const msg1 = 'user-msg-empty';
  const msg2 = 'user-msg-txt';
  const emptyAbs = path.join(locked, 'empty.txt');
  const txtAbs = path.join(locked, '1.txt');
  const createTxtDiff = buildFileChangeDiff('', '这是一个简单的文本文件。', '1.txt');
  if (!createTxtDiff) throw new Error('expected write_file create diff');

  await fs.writeFile(
    path.join(tmp, `${sessionId}.workspace.json`),
    JSON.stringify({ lockedRoot: locked }),
    'utf-8',
  );

  await captureIntentCheckpoint({
    sessionDir: tmp,
    sessionId,
    messageId: msg1,
    userMessageTime: 1000,
    workspaceRoot: locked,
    workspaceState: { referenceReads: [], changeCount: 0 },
    structuredMessages: [{ role: 'user', content: '新增一个空文件' }],
    uiMessages: [{ role: 'user', content: '新增一个空文件', id: msg1, sentAt: 1000 }],
  });

  beginIntentCheckpointTurn(sessionId, msg1, locked);
  await capturePreTurnWriteSnapshot(sessionId, locked, 'empty.txt');
  await fs.writeFile(emptyAbs, '', 'utf-8');
  await finalizeIntentCheckpointTurn(tmp, sessionId, msg1);
  await touchSessionTouchedPaths(tmp, sessionId, ['empty.txt']);

  await captureIntentCheckpoint({
    sessionDir: tmp,
    sessionId,
    messageId: msg2,
    userMessageTime: 2000,
    workspaceRoot: locked,
    workspaceState: { referenceReads: [], changeCount: 0 },
    structuredMessages: [
      { role: 'user', content: '新增一个空文件' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '新增一个1.txt文件' },
    ],
    uiMessages: [
      { role: 'user', content: '新增一个空文件', id: msg1, sentAt: 1000 },
      { role: 'user', content: '新增一个1.txt文件', id: msg2, sentAt: 2000 },
    ],
  });

  beginIntentCheckpointTurn(sessionId, msg2, locked);
  await capturePreTurnWriteSnapshot(sessionId, locked, '1.txt');
  await fs.writeFile(txtAbs, '这是一个简单的文本文件。', 'utf-8');
  await finalizeIntentCheckpointTurn(tmp, sessionId, msg2);
  await touchSessionTouchedPaths(tmp, sessionId, ['1.txt']);

  await fs.writeFile(
    path.join(tmp, `${sessionId}.json`),
    JSON.stringify([
      { role: 'user', content: '新增一个空文件', id: msg1, sentAt: 1000 },
      {
        role: 'tool_trace',
        toolName: 'write_file',
        detail: 'empty.txt',
        status: 'success',
        toolCallId: 'call-empty',
      },
      { role: 'agent', content: 'ok', id: 'agent-1', completedAt: 1500 },
      { role: 'user', content: '新增一个1.txt文件', id: msg2, sentAt: 2000 },
      {
        role: 'tool_trace',
        toolName: 'write_file',
        detail: '1.txt',
        status: 'success',
        toolCallId: 'call-txt',
        diffSource: createTxtDiff,
      },
      { role: 'agent', content: 'ok', id: 'agent-2', completedAt: 2500 },
    ]),
    'utf-8',
  );
  await fs.writeFile(
    path.join(tmp, `${sessionId}.structured.json`),
    JSON.stringify([
      { role: 'user', content: '新增一个空文件' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '新增一个1.txt文件' },
      { role: 'assistant', content: 'ok' },
    ]),
    'utf-8',
  );

  return { msg1, msg2, emptyAbs, txtAbs, createTxtDiff };
}

describe('RuntimeRestoreCoordinator', () => {
  let tmp: string;
  const sessionId = 'sess-restore';

  beforeEach(async () => {
    tmp = await makeTempDir();
    resetHarnessRuntimeRegistry();
    resetSessionContextWriteEpoch(sessionId);
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('rejects restore when harness is busy', async () => {
    beginSessionHarnessRun(sessionId);
    const coordinator = new RuntimeRestoreCoordinator();
    await expect(coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: 'msg-1',
      defaultWorkDir: tmp,
    })).rejects.toBeInstanceOf(RestoreNotAllowedError);
  });

  it('allows concurrent restore on different sessions', async () => {
    beginSessionHarnessRun('other-session');
    const coordinator = new RuntimeRestoreCoordinator();
    expect(coordinator.isRestoring(sessionId)).toBe(false);
    expect(coordinator.isRestoring('other-session')).toBe(false);
  });

  it('round-trips conversation and checkpoint via intent archive', async () => {
    const messageId = 'user-msg-1';
    const combined = {
      version: 1 as const,
      taskId: 't1',
      status: 'running' as const,
      userGoal: 'fix bug',
      phase: 'editing',
      taskState: {
        goal: 'fix bug',
        intent: 'edit' as const,
        phase: 'editing' as const,
        filesRead: [],
        filesChanged: ['src/a.ts'],
        commandsRun: [],
      },
      repoContext: {
        filesRead: [],
        filesChanged: ['src/a.ts'],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
      failedToolCalls: [],
      messageCount: 1,
      loop: { currentRound: 1, totalToolCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtimeV2: emptyRuntimeCheckpointV2('manual'),
    };
    await fs.writeFile(
      path.join(tmp, `${sessionId}.checkpoint.json`),
      JSON.stringify(combined, null, 2),
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmp, `${sessionId}.json`),
      JSON.stringify([
        { role: 'user', content: 'hello', id: messageId, sentAt: 1000 },
        { role: 'agent', content: 'hi', id: 'agent-1', completedAt: 2000 },
      ]),
      'utf-8',
    );

    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: 'hello' }],
      uiMessages: [{ role: 'user', content: 'hello', id: messageId, sentAt: 1000 }],
    });

    await fs.writeFile(
      path.join(tmp, `${sessionId}.json`),
      JSON.stringify([
        { role: 'user', content: 'hello', id: messageId, sentAt: 1000 },
        { role: 'agent', content: 'hi', id: 'agent-1', completedAt: 2000 },
        { role: 'user', content: 'next', id: 'user-msg-2', sentAt: 3000 },
      ]),
      'utf-8',
    );

    const coordinator = new RuntimeRestoreCoordinator();
    const epochBefore = sessionContextWriteEpoch(sessionId);
    const result = await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId,
      defaultWorkDir: tmp,
    });

    expect(result.systemEventContent).toContain('运行时已成功恢复');
    expect(isSessionContextWriteStale(sessionId, epochBefore)).toBe(true);

    const uiRaw = JSON.parse(await fs.readFile(path.join(tmp, `${sessionId}.json`), 'utf-8'));
    expect(uiRaw.some((m: { id?: string }) => m.id === messageId)).toBe(false);
    expect(uiRaw.filter((m: { role: string }) => m.role === 'user')).toHaveLength(0);

    const structuredRaw = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.structured.json`), 'utf-8'),
    );
    expect(structuredRaw).toEqual([]);

    const index = await loadCheckpointIndex(tmp, sessionId);
    expect(index.cursorMessageId).toBeNull();
    expect(index.entries).toHaveLength(0);
    expect(await loadIntentCheckpoint(tmp, sessionId, messageId)).toBeNull();

    const restoredCheckpoint = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.checkpoint.json`), 'utf-8'),
    );
    expect(restoredCheckpoint.extensions.restoredFromIntentMessageId).toBe(messageId);
  });

  it('keeps restored session-notes when a stale background notes write finishes later', async () => {
    const messageId = 'user-msg-notes-race';
    const notesFile = sessionNotesPath(tmp, sessionId);
    const cleanNotes = [
      '# Session Title',
      'before later turn',
      '',
      '# Runtime Evidence (auto)',
      '_auto_',
      '',
      '```icecoder-runtime',
      serializePersistedRuntime(
        {
          goal: '先做一件事',
          intent: 'edit',
          phase: 'editing',
          filesRead: [],
          filesChanged: ['empty.txt'],
          commandsRun: [],
        },
        {
          filesRead: [],
          filesChanged: ['empty.txt'],
          commandsRun: [],
          testCommands: [],
          recentDiagnostics: [],
        },
      ),
      '```',
    ].join('\n');
    const dirtyNotes = [
      '# Session Title',
      'after later turn',
      '',
      '# Runtime Evidence (auto)',
      '_auto_',
      '',
      '```icecoder-runtime',
      serializePersistedRuntime(
        {
          goal: '再建 1.txt',
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
    ].join('\n');

    await fs.writeFile(notesFile, cleanNotes, 'utf-8');
    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '先做一件事' }],
      uiMessages: [{ role: 'user', content: '先做一件事', id: messageId, sentAt: 1000 }],
    });
    await fs.writeFile(notesFile, dirtyNotes, 'utf-8');

    const staleEpoch = sessionContextWriteEpoch(sessionId);
    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId,
      defaultWorkDir: tmp,
    });

    expect(isSessionContextWriteStale(sessionId, staleEpoch)).toBe(true);
    if (!isSessionContextWriteStale(sessionId, staleEpoch)) {
      await fs.writeFile(notesFile, dirtyNotes, 'utf-8');
    }

    const restored = parsePersistedRuntime(await fs.readFile(notesFile, 'utf-8'));
    expect(restored?.task.filesChanged).toEqual(['empty.txt']);
    expect(restored?.task.filesChanged).not.toContain('1.txt');
    expect(await fs.readFile(notesFile, 'utf-8')).toContain('before later turn');
  });

  it('restores to an earlier checkpoint after a later restore', async () => {
    const msg1 = 'user-msg-1';
    const msg2 = 'user-msg-2';
    const msg3 = 'user-msg-3';
    const combined = {
      version: 1 as const,
      taskId: 't1',
      status: 'running' as const,
      userGoal: 'goal',
      phase: 'editing',
      taskState: {
        goal: 'goal',
        intent: 'edit' as const,
        phase: 'editing' as const,
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
      },
      repoContext: {
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
      failedToolCalls: [],
      messageCount: 1,
      loop: { currentRound: 1, totalToolCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtimeV2: emptyRuntimeCheckpointV2('manual'),
    };
    await fs.writeFile(
      path.join(tmp, `${sessionId}.checkpoint.json`),
      JSON.stringify(combined, null, 2),
      'utf-8',
    );

    async function captureAt(messageId: string, content: string, sentAt: number, prior: { id: string; content: string; sentAt: number }[]) {
      const uiMessages = [
        ...prior.map((p) => ({ role: 'user', content: p.content, id: p.id, sentAt: p.sentAt })),
        { role: 'user', content, id: messageId, sentAt },
      ];
      await captureIntentCheckpoint({
        sessionDir: tmp,
        sessionId,
        messageId,
        userMessageTime: sentAt,
        workspaceRoot: tmp,
        workspaceState: { referenceReads: [], changeCount: 0 },
        structuredMessages: uiMessages.map((m) => ({ role: 'user', content: m.content })),
        uiMessages,
      });
    }

    await captureAt(msg1, 'first', 1000, []);
    await captureAt(msg2, 'second', 2000, [{ id: msg1, content: 'first', sentAt: 1000 }]);
    await captureAt(msg3, 'third', 3000, [
      { id: msg1, content: 'first', sentAt: 1000 },
      { id: msg2, content: 'second', sentAt: 2000 },
    ]);

    const coordinator = new RuntimeRestoreCoordinator();

    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: msg3,
      defaultWorkDir: tmp,
    });
    let index = await loadCheckpointIndex(tmp, sessionId);
    expect(index.cursorMessageId).toBe(msg2);
    expect(index.cursorRestored).toBe(false);
    expect(index.entries.map((e) => e.messageId)).toEqual([msg1, msg2]);
    expect(await loadIntentCheckpoint(tmp, sessionId, msg3)).toBeNull();

    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: msg2,
      defaultWorkDir: tmp,
    });
    index = await loadCheckpointIndex(tmp, sessionId);
    expect(index.cursorMessageId).toBe(msg1);
    expect(index.cursorRestored).toBe(false);
    expect(index.entries.map((e) => e.messageId)).toEqual([msg1]);

    const uiRaw = JSON.parse(await fs.readFile(path.join(tmp, `${sessionId}.json`), 'utf-8'));
    expect(uiRaw.filter((m: { role: string }) => m.role === 'user')).toHaveLength(1);
    expect(uiRaw.some((m: { id?: string }) => m.id === msg1)).toBe(true);
    expect(uiRaw.some((m: { id?: string }) => m.id === msg2)).toBe(false);
    expect(uiRaw.some((m: { id?: string }) => m.id === msg3)).toBe(false);
  });

  it('truncates live session.json and structured.json so the restored turn cannot re-enter context', async () => {
    const msg1 = 'user-keep';
    const msg2 = 'user-restore';
    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg1,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: 'first' }],
      uiMessages: [{ role: 'user', content: 'first', id: msg1, sentAt: 1000 }],
    });
    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg2,
      userMessageTime: 2000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'ok1' },
        { role: 'user', content: 'second' },
      ],
      uiMessages: [
        { role: 'user', content: 'first', id: msg1, sentAt: 1000 },
        { role: 'agent', content: 'ok1', id: 'a1' },
        { role: 'user', content: 'second', id: msg2, sentAt: 2000 },
      ],
    });

    await fs.writeFile(path.join(tmp, `${sessionId}.json`), JSON.stringify([
      { role: 'user', content: 'first', id: msg1, sentAt: 1000 },
      { role: 'agent', content: 'ok1', id: 'a1' },
      { role: 'user', content: 'second', id: msg2, sentAt: 2000 },
      { role: 'agent', content: 'ok2', id: 'a2' },
    ]), 'utf-8');
    const liveStructured = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'ok1' },
      { role: 'user' as const, content: 'second' },
      { role: 'assistant' as const, content: 'ok2' },
    ];
    await fs.writeFile(
      path.join(tmp, `${sessionId}.structured.json`),
      JSON.stringify(liveStructured),
      'utf-8',
    );

    let cached = liveStructured.map((m) => ({ ...m }));
    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: msg2,
      defaultWorkDir: tmp,
      getStructuredMessages: () => cached,
      setStructuredMessages: (m) => { cached = (m ?? []) as typeof cached; },
    });

    const uiRaw = JSON.parse(await fs.readFile(path.join(tmp, `${sessionId}.json`), 'utf-8'));
    expect(uiRaw.map((m: { id?: string }) => m.id)).toEqual([msg1, 'a1']);
    expect(uiRaw.some((m: { content?: string }) => m.content === 'second')).toBe(false);

    const structuredRaw = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.structured.json`), 'utf-8'),
    );
    expect(structuredRaw).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok1' },
    ]);
    expect(cached).toEqual(structuredRaw);
  });

  it('rolls back workspace files when conversation write fails', async () => {
    const messageId = 'user-msg-ws';
    const filePath = 'src/rollback.ts';
    const absFile = path.join(tmp, filePath);
    await fs.mkdir(path.dirname(absFile), { recursive: true });
    await fs.writeFile(absFile, 'original-content', 'utf-8');

    const combined = {
      version: 1 as const,
      taskId: 't1',
      status: 'running' as const,
      userGoal: 'goal',
      phase: 'editing',
      taskState: {
        goal: 'goal',
        intent: 'edit' as const,
        phase: 'editing' as const,
        filesRead: [],
        filesChanged: [filePath],
        commandsRun: [],
      },
      repoContext: {
        filesRead: [],
        filesChanged: [filePath],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
      failedToolCalls: [],
      messageCount: 1,
      loop: { currentRound: 0, totalToolCalls: 0, totalInputTokens: 0, totalOutputTokens: 0 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      runtimeV2: emptyRuntimeCheckpointV2('manual'),
    };
    await fs.writeFile(
      path.join(tmp, `${sessionId}.checkpoint.json`),
      JSON.stringify(combined, null, 2),
      'utf-8',
    );

    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: 'hello' }],
      uiMessages: [{ role: 'user', content: 'hello', id: messageId, sentAt: 1000 }],
    });

    await fs.writeFile(absFile, 'mutated-before-restore-op', 'utf-8');

    const spy = vi.spyOn(captureModule, 'writeUiSessionMessages')
      .mockRejectedValueOnce(new Error('simulated ui write failure'));

    const coordinator = new RuntimeRestoreCoordinator();
    await expect(coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId,
      defaultWorkDir: tmp,
    })).rejects.toBeInstanceOf(RestoreFailedError);

    expect(await fs.readFile(absFile, 'utf-8')).toBe('mutated-before-restore-op');
    const rolledBackCheckpoint = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.checkpoint.json`), 'utf-8'),
    );
    expect(rolledBackCheckpoint.extensions.restoredFromIntentMessageId).toBeUndefined();
    spy.mockRestore();
  });

  it('rolls back structured messages from disk when the memory cache is empty', async () => {
    const messageId = 'user-msg-structured-disk';
    const liveStructured = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'ok' },
    ];
    await fs.writeFile(
      path.join(tmp, `${sessionId}.structured.json`),
      JSON.stringify(liveStructured),
      'utf-8',
    );
    await fs.writeFile(
      path.join(tmp, `${sessionId}.json`),
      JSON.stringify([{ role: 'user', content: 'hello', id: messageId, sentAt: 1000 }]),
      'utf-8',
    );
    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: 'hello' }],
      uiMessages: [{ role: 'user', content: 'hello', id: messageId, sentAt: 1000 }],
    });

    const spy = vi.spyOn(captureModule, 'writeUiSessionMessages')
      .mockRejectedValueOnce(new Error('simulated ui write failure'));

    const coordinator = new RuntimeRestoreCoordinator();
    await expect(coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId,
      defaultWorkDir: tmp,
      getStructuredMessages: () => [],
      setStructuredMessages: () => undefined,
    })).rejects.toBeInstanceOf(RestoreFailedError);

    const structuredRaw = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.structured.json`), 'utf-8'),
    );
    expect(structuredRaw).toEqual(liveStructured);
    spy.mockRestore();
  });

  it('restores workspace files changed during the same turn via pre-write snapshot', async () => {
    const messageId = 'user-msg-turn-write';
    const filePath = 'src/public/css/tokens.css';
    const absFile = path.join(tmp, filePath);
    await fs.mkdir(path.dirname(absFile), { recursive: true });
    await fs.writeFile(absFile, '--accent: #old-color;', 'utf-8');

    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '修改 tokens.css 主题色' }],
      uiMessages: [{
        role: 'user',
        content: '修改 tokens.css 主题色',
        id: messageId,
        sentAt: 1000,
      }],
    });

    beginIntentCheckpointTurn(sessionId, messageId, tmp);
    await capturePreTurnWriteSnapshot(sessionId, tmp, filePath);
    await fs.writeFile(absFile, '--accent: #3BEA7C;', 'utf-8');
    await finalizeIntentCheckpointTurn(tmp, sessionId, messageId);

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId,
      defaultWorkDir: tmp,
    });

    expect(await fs.readFile(absFile, 'utf-8')).toBe('--accent: #old-color;');
  });

  it('stores pre-write snapshots as workspace-relative paths when the tool path has a parent prefix', async () => {
    const messageId = 'user-msg-prefix-capture';
    const locked = path.join(tmp, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(locked, { recursive: true });
    const absFile = path.join(locked, 'empty.txt');

    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: locked,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '随便新增一个空文件' }],
      uiMessages: [{
        role: 'user',
        content: '随便新增一个空文件',
        id: messageId,
        sentAt: 1000,
      }],
    });

    beginIntentCheckpointTurn(sessionId, messageId, locked);
    await capturePreTurnWriteSnapshot(sessionId, locked, 'test/agentToolTest/20260910/empty.txt');
    await fs.writeFile(absFile, '', 'utf-8');
    await finalizeIntentCheckpointTurn(tmp, sessionId, messageId);

    const archive = await loadIntentCheckpoint(tmp, sessionId, messageId);
    expect(archive?.workspaceFiles).toMatchObject({ 'empty.txt': null });
    expect(archive?.workspaceFiles['test/agentToolTest/20260910/empty.txt']).toBeUndefined();
    expect(archive?.trackedPaths).toContain('empty.txt');
  });

  it('deletes a new file whose archive key still has a locked-folder parent prefix', async () => {
    const messageId = 'user-msg-prefix-restore';
    const locked = path.join(tmp, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(locked, { recursive: true });
    const absFile = path.join(locked, 'empty.txt');
    const nested = path.join(locked, 'test', 'agentToolTest', '20260910', 'empty.txt');
    await fs.writeFile(absFile, '', 'utf-8');

    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: locked,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '随便新增一个空文件' }],
      uiMessages: [{
        role: 'user',
        content: '随便新增一个空文件',
        id: messageId,
        sentAt: 1000,
      }],
    });

    const archive = await loadIntentCheckpoint(tmp, sessionId, messageId);
    expect(archive).toBeTruthy();
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...archive!,
      workspaceFiles: { 'test/agentToolTest/20260910/empty.txt': null },
      trackedPaths: ['test/agentToolTest/20260910/empty.txt'],
    });
    await touchSessionTouchedPaths(tmp, sessionId, ['test/agentToolTest/20260910/empty.txt']);

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId,
      defaultWorkDir: locked,
    });

    await expect(fs.access(absFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(nested)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deletes files created in later turns when restoring an earlier checkpoint', async () => {
    const locked = path.join(tmp, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(locked, { recursive: true });
    const seeded = await seedEmptyThenTxtTurns(tmp, sessionId, locked);

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: seeded.msg1,
      defaultWorkDir: locked,
    });

    await expect(fs.access(seeded.emptyAbs)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(seeded.txtAbs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps earlier-turn files when restoring a later checkpoint', async () => {
    const locked = path.join(tmp, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(locked, { recursive: true });
    const seeded = await seedEmptyThenTxtTurns(tmp, sessionId, locked);

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: seeded.msg2,
      defaultWorkDir: locked,
    });

    expect(await fs.readFile(seeded.emptyAbs, 'utf-8')).toBe('');
    await expect(fs.access(seeded.txtAbs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps earlier-turn files even if the later archive omitted them', async () => {
    const locked = path.join(tmp, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(locked, { recursive: true });
    const seeded = await seedEmptyThenTxtTurns(tmp, sessionId, locked);
    const archive2 = await loadIntentCheckpoint(tmp, sessionId, seeded.msg2);
    expect(archive2).toBeTruthy();
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...archive2!,
      workspaceFiles: { '1.txt': null },
      trackedPaths: ['1.txt'],
    });

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: seeded.msg2,
      defaultWorkDir: locked,
    });

    expect(await fs.readFile(seeded.emptyAbs, 'utf-8')).toBe('');
    await expect(fs.access(seeded.txtAbs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the current locked workspace root after restore', async () => {
    const locked = path.join(tmp, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(locked, { recursive: true });
    const seeded = await seedEmptyThenTxtTurns(tmp, sessionId, locked);

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: seeded.msg2,
      defaultWorkDir: locked,
    });

    const workspace = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.workspace.json`), 'utf-8'),
    ) as { lockedRoot?: string };
    expect(path.resolve(workspace.lockedRoot || '')).toBe(path.resolve(locked));
  });

  it('still deletes a later file if an earlier archive only recorded it as null', async () => {
    const locked = path.join(tmp, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(locked, { recursive: true });
    const seeded = await seedEmptyThenTxtTurns(tmp, sessionId, locked);
    const archive1 = await loadIntentCheckpoint(tmp, sessionId, seeded.msg1);
    expect(archive1).toBeTruthy();
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...archive1!,
      workspaceFiles: { ...archive1!.workspaceFiles, '1.txt': null },
      trackedPaths: [...new Set([...(archive1!.trackedPaths ?? []), '1.txt'])],
    });

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: seeded.msg2,
      defaultWorkDir: locked,
    });

    expect(await fs.readFile(seeded.emptyAbs, 'utf-8')).toBe('');
    await expect(fs.access(seeded.txtAbs)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not delete a pre-existing file that a later turn only read', async () => {
    const locked = path.join(tmp, 'test', 'agentToolTest', '20260910');
    await fs.mkdir(locked, { recursive: true });
    const readmeAbs = path.join(locked, 'readme.md');
    await fs.writeFile(readmeAbs, '# keep me', 'utf-8');

    const msg1 = 'user-msg-1';
    const msg2 = 'user-msg-2';
    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg1,
      userMessageTime: 1000,
      workspaceRoot: locked,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '先做一件事' }],
      uiMessages: [{ role: 'user', content: '先做一件事', id: msg1, sentAt: 1000 }],
    });
    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg2,
      userMessageTime: 2000,
      workspaceRoot: locked,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [
        { role: 'user', content: '先做一件事' },
        { role: 'user', content: '再读一下 readme' },
      ],
      uiMessages: [
        { role: 'user', content: '先做一件事', id: msg1, sentAt: 1000 },
        { role: 'user', content: '再读一下 readme', id: msg2, sentAt: 2000 },
      ],
    });

    const archive2 = await loadIntentCheckpoint(tmp, sessionId, msg2);
    expect(archive2).toBeTruthy();
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...archive2!,
      workspaceFiles: { 'readme.md': '# keep me' },
      trackedPaths: ['readme.md'],
    });

    await fs.writeFile(
      path.join(tmp, `${sessionId}.json`),
      JSON.stringify([
        { role: 'user', content: '先做一件事', id: msg1, sentAt: 1000 },
        { role: 'agent', content: 'ok', id: 'agent-1' },
        { role: 'user', content: '再读一下 readme', id: msg2, sentAt: 2000 },
        {
          role: 'tool_trace',
          toolName: 'read_file',
          detail: 'readme.md',
          status: 'success',
        },
        { role: 'agent', content: 'ok', id: 'agent-2' },
      ]),
      'utf-8',
    );

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: msg1,
      defaultWorkDir: locked,
    });

    expect(await fs.readFile(readmeAbs, 'utf-8')).toBe('# keep me');
  });

  it('deletes a file created by a shell command when restoring that turn', async () => {
    const messageId = 'user-msg-shell';
    const created = path.join(tmp, 'from-shell.txt');
    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '用命令新建文件' }],
      uiMessages: [{ role: 'user', content: '用命令新建文件', id: messageId, sentAt: 1000 }],
    });

    beginIntentCheckpointTurn(sessionId, messageId, tmp);
    recordPreTurnMissingFile(sessionId, tmp, 'from-shell.txt');
    await fs.writeFile(created, 'via run_command', 'utf-8');
    await finalizeIntentCheckpointTurn(tmp, sessionId, messageId);
    await touchSessionTouchedPaths(tmp, sessionId, ['from-shell.txt']);

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId,
      defaultWorkDir: tmp,
    });

    await expect(fs.access(created)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores a deleted file from a neighboring checkpoint snapshot', async () => {
    const msg1 = 'user-msg-poem';
    const msg2 = 'user-msg-later';
    const poemAbs = path.join(tmp, 'poem.txt');
    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg1,
      userMessageTime: 1000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [{ role: 'user', content: '写一首诗' }],
      uiMessages: [{ role: 'user', content: '写一首诗', id: msg1, sentAt: 1000 }],
    });
    const archive1 = await loadIntentCheckpoint(tmp, sessionId, msg1);
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...archive1!,
      workspaceFiles: { 'poem.txt': '床前明月光' },
      trackedPaths: ['poem.txt'],
    });

    await captureIntentCheckpoint({
      sessionDir: tmp,
      sessionId,
      messageId: msg2,
      userMessageTime: 2000,
      workspaceRoot: tmp,
      workspaceState: { referenceReads: [], changeCount: 0 },
      structuredMessages: [
        { role: 'user', content: '写一首诗' },
        { role: 'user', content: '删掉它' },
      ],
      uiMessages: [
        { role: 'user', content: '写一首诗', id: msg1, sentAt: 1000 },
        { role: 'user', content: '删掉它', id: msg2, sentAt: 2000 },
      ],
    });
    const archive2 = await loadIntentCheckpoint(tmp, sessionId, msg2);
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...archive2!,
      workspaceFiles: {},
      trackedPaths: [],
    });
    await fs.writeFile(
      path.join(tmp, `${sessionId}.json`),
      JSON.stringify([
        { role: 'user', content: '写一首诗', id: msg1, sentAt: 1000 },
        { role: 'user', content: '删掉它', id: msg2, sentAt: 2000 },
      ]),
      'utf-8',
    );

    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: msg2,
      defaultWorkDir: tmp,
    });

    expect(await fs.readFile(poemAbs, 'utf-8')).toBe('床前明月光');
  });
});

describe('CheckpointEngine restore lock', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('skips disk write while restore lock is active', async () => {
    const engine = new CheckpointEngine(tmp, 'lock-test');
    engine.setRestoreLock(true);
    await engine.save({ trigger: 'manual' });
    const exists = await fs.access(engine.checkpointPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
    engine.setRestoreLock(false);
  });
});
