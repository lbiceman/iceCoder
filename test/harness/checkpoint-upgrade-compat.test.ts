import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CheckpointEngine } from '../../src/harness/checkpoint-engine.js';
import { TaskCheckpointManager } from '../../src/harness/checkpoint.js';
import { ProjectCheckpointStore } from '../../src/harness/project-checkpoint-store.js';
import {
  intentCheckpointArchivePath,
  loadCheckpointIndex,
  loadIntentCheckpoint,
  rewriteIntentCheckpoint,
} from '../../src/harness/intent-checkpoint-store.js';
import {
  beginIntentCheckpointTurn,
  capturePreTurnWriteSnapshot,
  finalizeIntentCheckpointTurn,
} from '../../src/harness/intent-checkpoint-turn-snapshot.js';
import {
  RuntimeRestoreCoordinator,
  resetRuntimeRestoreCoordinator,
} from '../../src/harness/runtime-restore-coordinator.js';
import { resetHarnessRuntimeRegistry } from '../../src/harness/harness-runtime-registry.js';
import { emptyRuntimeCheckpointV2 } from '../../src/types/runtime-checkpoint.js';
import type { TaskCheckpoint } from '../../src/harness/checkpoint.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ice-upgrade-compat-'));
}

function v1Checkpoint(goal = 'Implement the remaining editor feature without losing session history'): TaskCheckpoint {
  return {
    version: 1,
    taskId: 'task-legacy',
    status: 'paused',
    userGoal: goal,
    phase: 'editing',
    taskState: {
      goal,
      intent: 'edit',
      phase: 'editing',
      filesRead: ['src/a.ts'],
      filesChanged: ['src/a.ts'],
      commandsRun: ['npm test'],
    },
    repoContext: {
      filesRead: ['src/a.ts'],
      filesChanged: ['src/a.ts'],
      commandsRun: ['npm test'],
      testCommands: ['npm test'],
      recentDiagnostics: [],
    },
    failedToolCalls: [],
    messageCount: 2,
    loop: {
      currentRound: 4,
      totalToolCalls: 3,
      totalInputTokens: 80,
      totalOutputTokens: 20,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    runtimeV2: emptyRuntimeCheckpointV2('manual'),
  } as TaskCheckpoint & { runtimeV2: ReturnType<typeof emptyRuntimeCheckpointV2> };
}

async function seedPreV3Session(sessionDir: string, sessionId: string): Promise<{
  v1: ReturnType<typeof v1Checkpoint>;
  uiMessages: Array<{ role: string; content: string; id: string; sentAt: number }>;
}> {
  const v1 = v1Checkpoint();
  const uiMessages = [
    { role: 'user', content: 'first', id: 'u1', sentAt: 1000 },
    { role: 'agent', content: 'done', id: 'a1', sentAt: 2000 },
    { role: 'user', content: 'second', id: 'u2', sentAt: 3000 },
  ];
  const workspaceFile = path.join(sessionDir, 'src', 'a.ts');
  await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
  await fs.writeFile(workspaceFile, 'after-edit', 'utf-8');

  const writeArchive = async (
    messageId: string,
    ui: typeof uiMessages,
    fileContent: string,
  ) => {
    const archive = {
      version: 1,
      messageId,
      sessionId,
      createdAt: '2026-01-01T00:00:00.000Z',
      userMessageTime: ui[ui.length - 1]?.sentAt ?? null,
      combinedCheckpoint: v1,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: sessionDir,
      workspaceFiles: { 'src/a.ts': fileContent },
      trackedPaths: ['src/a.ts'],
      structuredMessages: ui
        .filter(m => m.role === 'user')
        .map(m => ({ role: 'user' as const, content: m.content })),
      uiMessages: ui,
    };
    const dest = intentCheckpointArchivePath(sessionDir, sessionId, messageId);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, JSON.stringify(archive, null, 2), 'utf-8');
  };

  await fs.writeFile(
    path.join(sessionDir, `${sessionId}.checkpoint.json`),
    JSON.stringify(v1, null, 2),
    'utf-8',
  );
  await fs.writeFile(
    path.join(sessionDir, `${sessionId}.json`),
    JSON.stringify(uiMessages),
    'utf-8',
  );
  await fs.writeFile(
    path.join(sessionDir, `${sessionId}.checkpoint-index.json`),
    JSON.stringify({
      version: 1,
      cursorMessageId: 'u2',
      entries: [
        { messageId: 'u1', archiveFileName: 'u1.intent.json', createdAt: '2026-01-01T00:00:00.000Z', userMessageTime: 1000 },
        { messageId: 'u2', archiveFileName: 'u2.intent.json', createdAt: '2026-01-01T00:00:00.000Z', userMessageTime: 3000 },
      ],
    }, null, 2),
    'utf-8',
  );
  await writeArchive('u1', uiMessages.slice(0, 1), 'before');
  await writeArchive('u2', uiMessages, 'mid');
  return { v1, uiMessages };
}

describe('checkpoint upgrade compatibility', () => {
  let tmp: string;
  const sessionId = 'sess-upgrade';

  beforeEach(async () => {
    tmp = await makeTempDir();
    resetHarnessRuntimeRegistry();
    resetRuntimeRestoreCoordinator();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('loads a pre-V3 session without rewriting chat, intents, or the active checkpoint', async () => {
    const { v1 } = await seedPreV3Session(tmp, sessionId);
    const checkpointPath = path.join(tmp, `${sessionId}.checkpoint.json`);
    const chatPath = path.join(tmp, `${sessionId}.json`);
    const intentPath = intentCheckpointArchivePath(tmp, sessionId, 'u1');
    const beforeCheckpoint = await fs.readFile(checkpointPath, 'utf-8');
    const beforeChat = await fs.readFile(chatPath, 'utf-8');
    const beforeIntent = await fs.readFile(intentPath, 'utf-8');

    const store = new ProjectCheckpointStore({ sessionDir: tmp, sessionId });
    const loaded = await store.load();
    const intent = await loadIntentCheckpoint(tmp, sessionId, 'u1');
    const index = await loadCheckpointIndex(tmp, sessionId);

    expect(loaded?.execution.taskState.goal).toBe(v1.userGoal);
    expect(loaded?.extensions.legacyApi).toMatchObject({ status: 'paused', userGoal: v1.userGoal });
    expect(intent?.combinedCheckpoint).toMatchObject({ taskId: 'task-legacy' });
    expect(intent?.projectCheckpoint?.execution.taskState.goal).toBe(v1.userGoal);
    expect(intent?.uiMessages.map(m => m.id)).toEqual(['u1']);
    expect(index.entries.map(e => e.messageId)).toEqual(['u1', 'u2']);
    expect(await fs.readFile(checkpointPath, 'utf-8')).toBe(beforeCheckpoint);
    expect(await fs.readFile(chatPath, 'utf-8')).toBe(beforeChat);
    expect(await fs.readFile(intentPath, 'utf-8')).toBe(beforeIntent);
    await expect(fs.access(`${checkpointPath}.legacy.backup.json`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('restores an old combinedCheckpoint intent without rewriting that archive', async () => {
    await seedPreV3Session(tmp, sessionId);
    const coordinator = new RuntimeRestoreCoordinator();
    await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId: 'u1',
      defaultWorkDir: tmp,
    });

    const ui = JSON.parse(await fs.readFile(path.join(tmp, `${sessionId}.json`), 'utf-8')) as Array<{
      id: string;
    }>;
    expect(ui.map(m => m.id)).toEqual(['u1']);
    expect(await fs.readFile(path.join(tmp, 'src', 'a.ts'), 'utf-8')).toBe('before');

    const restored = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.checkpoint.json`), 'utf-8'),
    );
    expect(restored.version).toBe(3);
    expect(restored.execution.taskState.goal).toBe('Implement the remaining editor feature without losing session history');
    expect(restored.extensions.restoredFromIntentMessageId).toBe('u1');

    const u1OnDisk = JSON.parse(
      await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u1'), 'utf-8'),
    );
    expect(u1OnDisk.combinedCheckpoint.taskId).toBe('task-legacy');
    await expect(fs.access(intentCheckpointArchivePath(tmp, sessionId, 'u2'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('migrates the active file on first write, backs up v1, and does not strip old intents', async () => {
    await seedPreV3Session(tmp, sessionId);
    const manager = new TaskCheckpointManager(tmp, sessionId);
    await manager.save({
      status: 'running',
      userGoal: 'Implement the remaining editor feature without losing session history',
      taskState: {
        goal: 'Implement the remaining editor feature without losing session history',
        intent: 'edit',
        phase: 'editing',
        filesRead: ['src/a.ts'],
        filesChanged: ['src/a.ts'],
        commandsRun: ['npm test'],
      },
      repoContext: {
        filesRead: ['src/a.ts'],
        filesChanged: ['src/a.ts'],
        commandsRun: ['npm test'],
        testCommands: ['npm test'],
        recentDiagnostics: [],
      },
      loopState: {
        currentRound: 5,
        totalInputTokens: 90,
        totalOutputTokens: 24,
        lastInputTokens: 10,
        lastOutputTokens: 4,
        totalToolCalls: 4,
        startTime: 1,
      },
      messages: [{ role: 'user', content: 'continue' }],
    });

    const active = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.checkpoint.json`), 'utf-8'),
    );
    const backup = JSON.parse(
      await fs.readFile(path.join(tmp, `${sessionId}.checkpoint.json.legacy.backup.json`), 'utf-8'),
    );
    expect(active.version).toBe(3);
    expect(active.execution.taskState.goal).toBe('Implement the remaining editor feature without losing session history');
    expect(backup.version).toBe(1);
    expect(backup.taskId).toBe('task-legacy');

    const chat = JSON.parse(await fs.readFile(path.join(tmp, `${sessionId}.json`), 'utf-8'));
    expect(chat).toHaveLength(3);
    const u2 = JSON.parse(
      await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u2'), 'utf-8'),
    );
    expect(u2.combinedCheckpoint.taskId).toBe('task-legacy');
    expect(u2.uiMessages).toHaveLength(3);
  });

  it('keeps combinedCheckpoint on disk when an old intent is rewritten after upgrade', async () => {
    await seedPreV3Session(tmp, sessionId);
    const loaded = await loadIntentCheckpoint(tmp, sessionId, 'u2');
    expect(loaded?.combinedCheckpoint).toBeTruthy();
    await rewriteIntentCheckpoint(tmp, sessionId, {
      ...loaded!,
      workspaceFiles: { ...loaded!.workspaceFiles, 'src/b.ts': null },
      trackedPaths: [...loaded!.trackedPaths, 'src/b.ts'],
    });

    const onDisk = JSON.parse(
      await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u2'), 'utf-8'),
    );
    expect(onDisk.combinedCheckpoint.taskId).toBe('task-legacy');
    expect(onDisk.projectCheckpoint.execution.taskState.goal).toBe('Implement the remaining editor feature without losing session history');
    expect(onDisk.workspaceFiles['src/b.ts']).toBeNull();
  });

  it('does not drop combinedCheckpoint when finalizing a pre-V3 turn snapshot', async () => {
    await seedPreV3Session(tmp, sessionId);
    const src = path.join(tmp, 'src', 'a.ts');
    beginIntentCheckpointTurn(sessionId, 'u2', tmp);
    await capturePreTurnWriteSnapshot(sessionId, tmp, 'src/a.ts');
    await fs.writeFile(src, 'mutated', 'utf-8');
    await finalizeIntentCheckpointTurn(tmp, sessionId, 'u2');

    const onDisk = JSON.parse(
      await fs.readFile(intentCheckpointArchivePath(tmp, sessionId, 'u2'), 'utf-8'),
    );
    expect(onDisk.combinedCheckpoint.taskId).toBe('task-legacy');
    expect(onDisk.uiMessages).toHaveLength(3);
  });
});

describe('CheckpointEngine upgrade guards', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('refuses to replace an unreadable checkpoint with an empty stub', async () => {
    const engine = new CheckpointEngine(tmp, 'sess-guard');
    await fs.writeFile(engine.checkpointPath, '{not-json', 'utf-8');
    await engine.save({ trigger: 'tool_failed' });
    expect(await fs.readFile(engine.checkpointPath, 'utf-8')).toBe('{not-json');
  });
});
