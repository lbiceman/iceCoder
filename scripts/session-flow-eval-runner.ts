import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  DeleteMessageNotFoundError,
  deleteUserMessageConversation,
} from '../src/harness/conversation-delete.js';
import {
  loadCheckpointIndex,
  loadIntentCheckpoint,
  saveIntentCheckpoint,
} from '../src/harness/intent-checkpoint-store.js';
import { captureIntentCheckpoint } from '../src/harness/intent-checkpoint-capture.js';
import {
  resetHarnessRuntimeRegistry,
} from '../src/harness/harness-runtime-registry.js';
import { RuntimeRestoreCoordinator } from '../src/harness/runtime-restore-coordinator.js';
import {
  isSessionContextWriteStale,
  resetSessionContextWriteEpoch,
  sessionContextWriteEpoch,
} from '../src/harness/session-context-write-gate.js';
import {
  parsePersistedRuntime,
  serializePersistedRuntime,
  sessionNotesPath,
} from '../src/memory/file-memory/session-memory.js';
import type { UnifiedMessage } from '../src/llm/types.js';
import {
  appendQueuedAlsoNotesToMessages,
  parseAlsoCommand,
  parseNextCommand,
  queueAlsoNote,
  resetPendingNotesForTests,
  setActiveAlsoRun,
} from '../src/session/pending-note.js';
import { TaskQueueManager } from '../src/session/task-queue.js';
import type {
  IntentCheckpointArchive,
  UiChatMessage,
} from '../src/types/intent-checkpoint.js';

export interface SessionFlowEvalCaseResult {
  id: string;
  category: 'delete' | 'restore' | 'also' | 'next' | 'isolation';
  passed: boolean;
  durationMs: number;
  failures: string[];
}

export interface SessionFlowEvalReport {
  timestamp: string;
  mode: 'deterministic';
  caseCount: number;
  passedCount: number;
  passRate: number;
  results: SessionFlowEvalCaseResult[];
}

export interface RunSessionFlowEvalOptions {
  workspaceRoot: string;
}

interface EvalCase {
  id: string;
  category: SessionFlowEvalCaseResult['category'];
  run(caseDir: string): Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected=${expectedJson} actual=${actualJson}`);
  }
}

function checkpointArchive(
  sessionId: string,
  messageId: string,
  workspaceRoot: string,
  uiMessages: UiChatMessage[],
  structuredMessages: UnifiedMessage[],
): IntentCheckpointArchive {
  return {
    version: 1,
    messageId,
    sessionId,
    createdAt: new Date().toISOString(),
    userMessageTime: null,
    combinedCheckpoint: null,
    workspace: { referenceReads: [], changeCount: 0 },
    workspaceRoot,
    workspaceFiles: {},
    trackedPaths: [],
    uiMessages,
    structuredMessages,
  };
}

async function writeConversationFixture(caseDir: string, sessionId: string): Promise<{
  uiMessages: UiChatMessage[];
  structuredMessages: UnifiedMessage[];
}> {
  const uiMessages: UiChatMessage[] = [
    { role: 'user', id: 'u1', content: 'first' },
    { role: 'agent', id: 'a1', content: 'answer one' },
    { role: 'user', id: 'u2', content: 'delete me' },
    { role: 'agent', id: 'a2', content: 'answer two' },
    { role: 'user', id: 'u3', content: 'last' },
  ];
  const structuredMessages: UnifiedMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer one' },
    { role: 'user', content: 'delete me' },
    { role: 'assistant', content: 'answer two' },
    { role: 'user', content: 'last' },
  ];
  await fs.mkdir(caseDir, { recursive: true });
  await fs.writeFile(path.join(caseDir, `${sessionId}.json`), JSON.stringify(uiMessages), 'utf-8');
  await fs.writeFile(
    path.join(caseDir, `${sessionId}.structured.json`),
    JSON.stringify(structuredMessages),
    'utf-8',
  );
  for (const [messageId, end] of [['u1', 1], ['u2', 3], ['u3', 5]] as const) {
    await saveIntentCheckpoint({
      sessionDir: caseDir,
      sessionId,
      archive: checkpointArchive(
        sessionId,
        messageId,
        caseDir,
        uiMessages.slice(0, end),
        structuredMessages.slice(0, end),
      ),
    });
  }
  return { uiMessages, structuredMessages };
}

function runtimeNotes(title: string, filesChanged: string[]): string {
  return [
    '# Session Title',
    title,
    '',
    '# Runtime Evidence (auto)',
    '_auto_',
    '',
    '```icecoder-runtime',
    serializePersistedRuntime(
      {
        goal: title,
        intent: 'edit',
        phase: 'editing',
        filesRead: [],
        filesChanged,
        commandsRun: [],
      },
      {
        filesRead: [],
        filesChanged,
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
    ),
    '```',
  ].join('\n');
}

const cases: EvalCase[] = [
  {
    id: 'delete-single-middle-message',
    category: 'delete',
    async run(caseDir) {
      const sessionId = 'delete-middle';
      await writeConversationFixture(caseDir, sessionId);
      await deleteUserMessageConversation({ sessionDir: caseDir, sessionId, messageId: 'u2' });

      const ui = JSON.parse(
        await fs.readFile(path.join(caseDir, `${sessionId}.json`), 'utf-8'),
      ) as UiChatMessage[];
      const structured = JSON.parse(
        await fs.readFile(path.join(caseDir, `${sessionId}.structured.json`), 'utf-8'),
      ) as UnifiedMessage[];
      const index = await loadCheckpointIndex(caseDir, sessionId);
      const later = await loadIntentCheckpoint(caseDir, sessionId, 'u3');

      assertJsonEqual(ui.map(message => message.id), ['u1', 'a1', 'u3'], 'UI should remove u2 and its agent reply');
      assertJsonEqual(
        structured.map(message => message.content),
        ['first', 'answer one', 'last'],
        'structured history should remove the user turn and assistant reply',
      );
      assertJsonEqual(
        index.entries.map(entry => entry.messageId),
        ['u1', 'u3'],
        'checkpoint index should preserve later entries',
      );
      assert(later !== null, 'later checkpoint should remain');
      assert(!later.uiMessages.some(message => message.id === 'u2'), 'later UI snapshot still contains u2');
      assert(
        !later.structuredMessages.some(message => message.role === 'user' && message.content === 'delete me'),
        'later structured snapshot still contains deleted content',
      );
    },
  },
  {
    id: 'delete-missing-message-is-noop',
    category: 'delete',
    async run(caseDir) {
      const sessionId = 'delete-missing';
      await writeConversationFixture(caseDir, sessionId);
      const uiFile = path.join(caseDir, `${sessionId}.json`);
      const structuredFile = path.join(caseDir, `${sessionId}.structured.json`);
      const beforeUi = await fs.readFile(uiFile, 'utf-8');
      const beforeStructured = await fs.readFile(structuredFile, 'utf-8');
      let rejected = false;
      try {
        await deleteUserMessageConversation({ sessionDir: caseDir, sessionId, messageId: 'missing' });
      } catch (error) {
        rejected = error instanceof DeleteMessageNotFoundError;
      }
      assert(rejected, 'missing message should raise DeleteMessageNotFoundError');
      assert((await fs.readFile(uiFile, 'utf-8')) === beforeUi, 'UI file changed after missing delete');
      assert(
        (await fs.readFile(structuredFile, 'utf-8')) === beforeStructured,
        'structured file changed after missing delete',
      );
    },
  },
  {
    id: 'delete-scrubs-session-notes-runtime',
    category: 'delete',
    async run(caseDir) {
      resetSessionContextWriteEpoch('delete-notes');
      const sessionId = 'delete-notes';
      const notesFile = sessionNotesPath(caseDir, sessionId);
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(
        path.join(caseDir, `${sessionId}.json`),
        JSON.stringify([
          { role: 'user', id: 'u1', content: '先建空文件' },
          { role: 'tool_trace', toolName: 'write_file', detail: 'empty.txt', status: 'success' },
          { role: 'user', id: 'u2', content: '再建 1.txt' },
          { role: 'tool_trace', toolName: 'write_file', detail: '1.txt', status: 'success' },
        ]),
        'utf-8',
      );
      await fs.writeFile(
        path.join(caseDir, `${sessionId}.structured.json`),
        JSON.stringify([
          { role: 'user', content: '先建空文件' },
          { role: 'user', content: '再建 1.txt' },
        ]),
        'utf-8',
      );
      await fs.writeFile(notesFile, runtimeNotes('再建 1.txt', ['empty.txt', '1.txt']), 'utf-8');

      const epochBefore = sessionContextWriteEpoch(sessionId);
      await deleteUserMessageConversation({ sessionDir: caseDir, sessionId, messageId: 'u2' });

      const notes = parsePersistedRuntime(await fs.readFile(notesFile, 'utf-8'));
      assertJsonEqual(notes?.task.filesChanged, ['empty.txt'], 'deleted-turn path should leave session-notes');
      assert(!notes?.task.filesChanged.includes('1.txt'), '1.txt should be scrubbed from session-notes');
      assert(isSessionContextWriteStale(sessionId, epochBefore), 'delete should invalidate in-flight notes writes');
    },
  },
  {
    id: 'restore-rejects-stale-session-notes-write',
    category: 'restore',
    async run(caseDir) {
      resetHarnessRuntimeRegistry();
      resetSessionContextWriteEpoch('restore-notes');
      const sessionId = 'restore-notes';
      const messageId = 'user-msg-1';
      const notesFile = sessionNotesPath(caseDir, sessionId);
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(notesFile, runtimeNotes('先做一件事', ['empty.txt']), 'utf-8');
      await captureIntentCheckpoint({
        sessionDir: caseDir,
        sessionId,
        messageId,
        userMessageTime: 1000,
        workspaceRoot: caseDir,
        workspaceState: { referenceReads: [], changeCount: 0 },
        structuredMessages: [{ role: 'user', content: '先做一件事' }],
        uiMessages: [{ role: 'user', content: '先做一件事', id: messageId, sentAt: 1000 }],
      });
      await fs.writeFile(notesFile, runtimeNotes('再建 1.txt', ['empty.txt', '1.txt']), 'utf-8');

      const staleEpoch = sessionContextWriteEpoch(sessionId);
      await new RuntimeRestoreCoordinator().restore({
        sessionDir: caseDir,
        sessionId,
        messageId,
        defaultWorkDir: caseDir,
      });

      assert(isSessionContextWriteStale(sessionId, staleEpoch), 'restore should invalidate in-flight notes writes');
      if (!isSessionContextWriteStale(sessionId, staleEpoch)) {
        await fs.writeFile(notesFile, runtimeNotes('再建 1.txt', ['empty.txt', '1.txt']), 'utf-8');
      }
      const notes = parsePersistedRuntime(await fs.readFile(notesFile, 'utf-8'));
      assertJsonEqual(notes?.task.filesChanged, ['empty.txt'], 'stale notes write overwrote restored checkpoint');
      assert(!notes?.task.filesChanged.includes('1.txt'), 'rolled-back file returned via stale notes write');
    },
  },
  {
    id: 'also-active-run-injection',
    category: 'also',
    async run() {
      resetPendingNotesForTests();
      const parsed = parseAlsoCommand('#skill\n/also  后续只修改测试');
      assertJsonEqual(parsed, { matched: true, text: '后续只修改测试' }, '/also parse mismatch');
      setActiveAlsoRun('s1', 10);
      queueAlsoNote('s1', { text: parsed.text, runId: 10, messageId: 'also-1' });
      const messages: UnifiedMessage[] = [{ role: 'user', content: 'main task' }];
      const drained = appendQueuedAlsoNotesToMessages(messages, 's1');
      assert(drained.length === 1, '/also note was not drained');
      assertJsonEqual(messages[1], {
        role: 'user',
        content: '后续只修改测试',
        preserveOnCompaction: true,
        alsoNote: true,
      }, '/also canonical message mismatch');
      assert(appendQueuedAlsoNotesToMessages(messages, 's1').length === 0, '/also note injected twice');
    },
  },
  {
    id: 'also-run-and-session-isolation',
    category: 'isolation',
    async run() {
      resetPendingNotesForTests();
      setActiveAlsoRun('s1', 11);
      setActiveAlsoRun('s2', 20);
      queueAlsoNote('s1', { text: 'old run', runId: 10, messageId: 'm1' });
      queueAlsoNote('s1', { text: 'current run', runId: 11, messageId: 'm2' });
      queueAlsoNote('s2', { text: 'other session', runId: 20, messageId: 'm3' });
      const s1Messages: UnifiedMessage[] = [];
      const s2Messages: UnifiedMessage[] = [];
      appendQueuedAlsoNotesToMessages(s1Messages, 's1');
      appendQueuedAlsoNotesToMessages(s2Messages, 's2');
      assertJsonEqual(s1Messages.map(message => message.content), ['current run'], 'run isolation failed');
      assertJsonEqual(s2Messages.map(message => message.content), ['other session'], 'session isolation failed');
    },
  },
  {
    id: 'next-explicit-fifo-persistence',
    category: 'next',
    async run(caseDir) {
      const parsed = parseNextCommand('#skill\n/next 修复登录页');
      assertJsonEqual(parsed, { matched: true, text: '修复登录页' }, '/next parse mismatch');
      const manager = new TaskQueueManager(caseDir);
      await manager.enqueue('s1', { text: 'current implicit', source: 'implicit', messageId: 'm1' });
      await manager.enqueue('s1', { text: parsed.text, source: 'explicit', messageId: 'm2' });
      const restored = new TaskQueueManager(caseDir);
      const queued = await restored.list('s1');
      assertJsonEqual(
        queued.map(task => ({ text: task.text, source: task.source, messageId: task.messageId })),
        [
          { text: 'current implicit', source: 'implicit', messageId: 'm1' },
          { text: '修复登录页', source: 'explicit', messageId: 'm2' },
        ],
        '/next FIFO persistence mismatch',
      );
      assert((await restored.dequeue('s1'))?.messageId === 'm1', 'FIFO head mismatch');
      assert((await restored.dequeue('s1'))?.messageId === 'm2', 'explicit /next did not run second');
    },
  },
  {
    id: 'task-queue-four-item-drain-keeps-tail',
    category: 'next',
    async run(caseDir) {
      const manager = new TaskQueueManager(caseDir);
      await manager.enqueue('s1', { text: 'q1', source: 'implicit', messageId: 'm1' });
      await manager.enqueue('s1', { text: 'q2', source: 'implicit', messageId: 'm2' });
      await manager.enqueue('s1', { text: 'q3', source: 'implicit', messageId: 'm3' });
      await manager.enqueue('s1', { text: 'q4', source: 'implicit', messageId: 'm4' });

      assert((await manager.dequeue('s1'))?.messageId === 'm1', 'first should dequeue');
      assert((await manager.dequeue('s1'))?.messageId === 'm2', 'second should dequeue');
      assert((await manager.dequeue('s1'))?.messageId === 'm3', 'third should dequeue');
      const leftover = await manager.list('s1');
      assert(
        leftover.length === 1 && leftover[0].messageId === 'm4',
        'last item must remain after 3/4 drain',
      );

      const restored = new TaskQueueManager(caseDir);
      assert(
        (await restored.list('s1'))[0]?.messageId === 'm4',
        'last item must persist after 3/4 drain',
      );

      await Promise.all([
        manager.enqueue('s1', { text: 'late-a', source: 'implicit', messageId: 'la' }),
        manager.enqueue('s1', { text: 'late-b', source: 'implicit', messageId: 'lb' }),
        manager.enqueue('s1', { text: 'late-c', source: 'implicit', messageId: 'lc' }),
      ]);
      const afterLate = await manager.list('s1');
      assert(afterLate.length === 4, `late concurrent enqueue lost items: ${afterLate.length}`);
      const ids = new Set(afterLate.map(task => task.messageId));
      assert(ids.has('m4') && ids.has('la') && ids.has('lb') && ids.has('lc'), 'late items missing');
    },
  },
  {
    id: 'task-queue-session-isolation',
    category: 'isolation',
    async run(caseDir) {
      const manager = new TaskQueueManager(caseDir);
      await manager.enqueue('s1', { text: 'session one', source: 'explicit' });
      await manager.enqueue('s2', { text: 'session two', source: 'explicit' });
      await manager.insertAt('s1', 0, { text: 'session one first', source: 'explicit' });
      assertJsonEqual(
        (await manager.list('s1')).map(task => task.text),
        ['session one first', 'session one'],
        's1 ordering mismatch',
      );
      assertJsonEqual(
        (await manager.list('s2')).map(task => task.text),
        ['session two'],
        's2 queue was contaminated',
      );
    },
  },
];

export async function runSessionFlowEval(
  options: RunSessionFlowEvalOptions,
): Promise<SessionFlowEvalReport> {
  await fs.mkdir(options.workspaceRoot, { recursive: true });
  const results: SessionFlowEvalCaseResult[] = [];
  for (const testCase of cases) {
    const startedAt = Date.now();
    const caseDir = path.join(options.workspaceRoot, testCase.id);
    try {
      await testCase.run(caseDir);
      results.push({
        id: testCase.id,
        category: testCase.category,
        passed: true,
        durationMs: Date.now() - startedAt,
        failures: [],
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        category: testCase.category,
        passed: false,
        durationMs: Date.now() - startedAt,
        failures: [error instanceof Error ? error.message : String(error)],
      });
    } finally {
      resetPendingNotesForTests();
      resetSessionContextWriteEpoch();
      resetHarnessRuntimeRegistry();
    }
  }
  const passedCount = results.filter(result => result.passed).length;
  return {
    timestamp: new Date().toISOString(),
    mode: 'deterministic',
    caseCount: results.length,
    passedCount,
    passRate: results.length > 0 ? passedCount / results.length : 0,
    results,
  };
}
