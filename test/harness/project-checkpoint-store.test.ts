import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ProjectCheckpointStore,
  StaleCheckpointWriteError,
} from '../../src/harness/project-checkpoint-store.js';
import {
  intentCheckpointArchivePath,
  loadIntentCheckpoint,
  saveIntentCheckpoint,
} from '../../src/harness/intent-checkpoint-store.js';
import { TaskCheckpointManager } from '../../src/harness/checkpoint.js';
import type { IntentCheckpointArchive } from '../../src/types/intent-checkpoint.js';
import type { ProjectCheckpointV3 } from '../../src/types/runtime-checkpoint.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-project-checkpoint-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function checkpoint(sessionId = 'session-1', checkpointId = 'checkpoint-1'): ProjectCheckpointV3 {
  return {
    version: 3,
    identity: { checkpointId, projectId: 'project-1', sessionId },
    execution: {
      taskState: {
        goal: 'Persist a complete aggregate',
        intent: 'edit',
        phase: 'editing',
        filesRead: ['src/a.ts'],
        filesChanged: ['src/a.ts'],
        commandsRun: [],
      },
      loopState: {
        currentRound: 1,
        totalInputTokens: 10,
        totalOutputTokens: 4,
        lastInputTokens: 10,
        lastOutputTokens: 4,
        totalToolCalls: 1,
        startTime: 1,
      },
    },
    completion: {
      conditions: [],
      operationOutcomes: [],
    },
    conversation: { messages: [{ role: 'user', content: 'save' }] },
    workspace: {
      root: tempDir,
      repoContext: {
        filesRead: ['src/a.ts'],
        filesChanged: ['src/a.ts'],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
    },
    memory: {},
    snapshotMeta: {
      capturedAt: '2026-09-09T00:00:00.000Z',
      trigger: 'manual',
    },
    extensions: {},
    migration: null,
  };
}

describe('ProjectCheckpointStore', () => {
  it('atomically saves and loads one complete V3 session file', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    const saved = await store.save(checkpoint(), { generation: 1 });
    const loaded = await store.load();

    expect(saved.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(loaded).toEqual(saved.checkpoint);
    expect(loaded?.snapshotMeta.sequence).toBe(1);
    expect((await fs.readdir(tempDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects a stale generation without replacing the newer aggregate', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    await store.save(checkpoint('session-1', 'newer'), { generation: 2 });

    await expect(store.save(
      checkpoint('session-1', 'stale'),
      { generation: 1 },
    )).rejects.toBeInstanceOf(StaleCheckpointWriteError);
    expect((await store.load())?.identity.checkpointId).toBe('newer');
  });

  it('backs up legacy once and rewrites it to V3 on first durable save', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    const legacy = {
      version: 1,
      task: {
        goal: 'legacy',
        intent: 'edit',
        phase: 'editing',
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
        verificationRequired: false,
        verificationStatus: 'not_required',
      },
      repo: {
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
    };
    await fs.writeFile(store.checkpointPath, JSON.stringify(legacy), 'utf-8');

    await store.save(checkpoint(), { generation: 1 });
    expect(JSON.parse(await fs.readFile(store.legacyBackupPath, 'utf-8'))).toEqual(legacy);
    expect(JSON.parse(await fs.readFile(store.checkpointPath, 'utf-8')).version).toBe(3);

    await store.save(checkpoint('session-1', 'second'), { generation: 2 });
    expect(JSON.parse(await fs.readFile(store.legacyBackupPath, 'utf-8'))).toEqual(legacy);
  });

  it('preserves a corrupt legacy file before replacing it with valid V3', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    await fs.writeFile(store.checkpointPath, '{broken checkpoint', 'utf-8');

    await store.save(checkpoint());

    expect(await fs.readFile(store.legacyBackupPath, 'utf-8')).toBe('{broken checkpoint');
    expect(JSON.parse(await fs.readFile(store.checkpointPath, 'utf-8')).version).toBe(3);
  });

  it('fences generation from disk when save happens before load', async () => {
    const durable = checkpoint();
    durable.snapshotMeta.sequence = 7;
    const checkpointPath = path.join(tempDir, 'session-1.checkpoint.json');
    await fs.writeFile(checkpointPath, JSON.stringify(durable), 'utf-8');

    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    const next = checkpoint('session-1', 'next');
    next.snapshotMeta.sequence = 7;
    const saved = await store.save(next);

    expect(saved.generation).toBe(8);
    expect(saved.checkpoint.snapshotMeta.parentGeneration).toBe(7);
  });

  it('rejects an automatically saved stale snapshot after disk advances', async () => {
    const first = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    const captured = await first.save(checkpoint('session-1', 'captured'));
    const newer = structuredClone(captured.checkpoint);
    newer.identity.checkpointId = 'newer';
    await first.save(newer);

    const second = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    await expect(second.save(captured.checkpoint)).rejects.toMatchObject({
      code: 'STALE_CHECKPOINT_WRITE',
      generation: 1,
      currentGeneration: 2,
    });
    expect((await second.load())?.identity.checkpointId).toBe('newer');
  });

  it('recovers the displaced checkpoint when a replacement was interrupted', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    const old = checkpoint('session-1', 'recover-me');
    old.snapshotMeta.sequence = 4;
    await fs.writeFile(store.recoveryDisplacedPath, JSON.stringify(old), 'utf-8');
    await fs.writeFile(
      store.recoveryMarkerPath,
      JSON.stringify({ version: 1, phase: 'displaced' }),
      'utf-8',
    );

    const loaded = await store.load();

    expect(loaded?.identity.checkpointId).toBe('recover-me');
    expect(await fs.access(store.checkpointPath).then(() => true)).toBe(true);
    expect(await fs.access(store.recoveryDisplacedPath).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(store.recoveryMarkerPath).then(() => true).catch(() => false)).toBe(false);
  });

  it('never writes legacy completion mirror fields into V3 JSON', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    await store.save(checkpoint());
    const raw = await fs.readFile(store.checkpointPath, 'utf-8');

    for (const forbidden of [
      'verificationStatus',
      'verificationRequired',
      'verificationPending',
      'acceptanceGate',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it('round-trips a V3 runtime payload through an intent archive', async () => {
    const archive: IntentCheckpointArchive = {
      version: 1,
      messageId: 'message-1',
      sessionId: 'session-1',
      createdAt: '2026-09-09T00:00:00.000Z',
      userMessageTime: 1,
      projectCheckpoint: checkpoint(),
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: tempDir,
      workspaceFiles: { 'src/a.ts': 'before' },
      trackedPaths: ['src/a.ts'],
      structuredMessages: [{ role: 'user', content: 'save' }],
      uiMessages: [{ role: 'user', content: 'save', id: 'message-1' }],
    };
    await saveIntentCheckpoint({ sessionDir: tempDir, sessionId: 'session-1', archive });

    const loaded = await loadIntentCheckpoint(tempDir, 'session-1', 'message-1');
    expect(loaded?.projectCheckpoint).toEqual(archive.projectCheckpoint);
    expect(loaded?.combinedCheckpoint).toBeUndefined();
  });

  it('restores an intent snapshot as the next generation with provenance', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    await store.save(checkpoint('session-1', 'current'), { generation: 4 });
    const archived = checkpoint('session-1', 'archived');
    const restored = await store.restoreFromIntent({
      messageId: 'message-restore',
      projectCheckpoint: archived,
    });

    expect(restored.generation).toBe(5);
    expect(restored.checkpoint.identity.checkpointId).toBe('archived');
    expect(restored.checkpoint.extensions.restoredFromIntentMessageId).toBe('message-restore');
    expect(await store.load()).toEqual(restored.checkpoint);
  });

  it('preserves existing V3 extensions when TaskCheckpointManager updates core sections', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    const original = checkpoint();
    original.extensions = {
      runtimeResilience: { runtimeVersion: 2, recentTools: [{ toolName: 'read_file' }] },
      taskGraph: { nodes: ['a'] },
      futureRoundSnapshots: { enabled: true },
    };
    await store.save(original);

    const manager = new TaskCheckpointManager(tempDir, 'session-1');
    await manager.save({
      status: 'running',
      userGoal: 'Implement updated checkpoint behavior',
      taskState: {
        goal: 'Implement updated checkpoint behavior',
        intent: 'edit',
        phase: 'editing',
        filesRead: [],
        filesChanged: ['src/updated.ts'],
        commandsRun: [],
      },
      repoContext: {
        filesRead: [],
        filesChanged: ['src/updated.ts'],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
      loopState: {
        currentRound: 2,
        totalInputTokens: 20,
        totalOutputTokens: 5,
        lastInputTokens: 10,
        lastOutputTokens: 1,
        totalToolCalls: 2,
        startTime: 1,
      },
      messages: [{ role: 'user', content: 'Implement updated checkpoint behavior' }],
    });

    const loaded = await store.load();
    expect(loaded?.execution.taskState.goal).toBe('Implement updated checkpoint behavior');
    expect(loaded?.extensions.runtimeResilience).toEqual(original.extensions.runtimeResilience);
    expect(loaded?.extensions.taskGraph).toEqual(original.extensions.taskGraph);
    expect(loaded?.extensions.futureRoundSnapshots).toEqual(original.extensions.futureRoundSnapshots);
  });

  it('loads an old intent with null combined checkpoint from its runtime notes', async () => {
    const messageId = 'legacy-notes';
    const archive = {
      version: 1,
      messageId,
      sessionId: 'session-1',
      createdAt: '2026-09-09T00:00:00.000Z',
      userMessageTime: 1,
      combinedCheckpoint: null,
      workspace: { referenceReads: [], changeCount: 0 },
      workspaceRoot: tempDir,
      workspaceFiles: {},
      trackedPaths: [],
      structuredMessages: [{ role: 'user', content: 'resume notes' }],
      uiMessages: [],
      sessionNotesContent: [
        '# notes',
        '```icecoder-runtime',
        JSON.stringify({
          version: 1,
          task: {
            goal: 'restored from notes',
            intent: 'edit',
            phase: 'editing',
            filesRead: [],
            filesChanged: [],
            commandsRun: [],
          },
          repo: {
            filesRead: [],
            filesChanged: [],
            commandsRun: [],
            testCommands: [],
            recentDiagnostics: [],
          },
        }),
        '```',
      ].join('\n'),
    };
    const archiveFile = intentCheckpointArchivePath(tempDir, 'session-1', messageId);
    await fs.mkdir(path.dirname(archiveFile), { recursive: true });
    await fs.writeFile(archiveFile, JSON.stringify(archive), 'utf-8');

    const loaded = await loadIntentCheckpoint(tempDir, 'session-1', messageId);
    expect(loaded?.projectCheckpoint?.execution.taskState.goal).toBe('restored from notes');
    expect(loaded?.combinedCheckpoint).toBeNull();
  });

  it('keeps the original file when a native save is rejected', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    const original = checkpoint();
    await store.save(original);
    const before = await fs.readFile(store.checkpointPath, 'utf-8');

    await expect(store.save({
      ...original,
      identity: { ...original.identity, checkpointId: '' },
    })).rejects.toBeInstanceOf(TypeError);
    expect(await fs.readFile(store.checkpointPath, 'utf-8')).toBe(before);
  });

  it('does not durable-write while persist is blocked', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    store.setPersistBlocked(true);
    await store.save(checkpoint());
    await expect(fs.access(store.checkpointPath)).rejects.toMatchObject({ code: 'ENOENT' });
    store.setPersistBlocked(false);
    await store.save(checkpoint());
    expect((await store.load())?.identity.checkpointId).toBe('checkpoint-1');
  });

  it('isolates concurrent sessions', async () => {
    const left = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-a' });
    const right = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-b' });
    await Promise.all([
      left.save(checkpoint('session-a', 'a')),
      right.save(checkpoint('session-b', 'b')),
    ]);
    expect((await left.load())?.identity.checkpointId).toBe('a');
    expect((await right.load())?.identity.checkpointId).toBe('b');
  });

  it('restores a snapshot without requiring an Intent archive wrapper', async () => {
    const store = new ProjectCheckpointStore({ sessionDir: tempDir, sessionId: 'session-1' });
    await store.save(checkpoint('session-1', 'current'), { generation: 2 });
    const restored = await store.restore(checkpoint('session-1', 'from-snapshot'), {
      intentMessageId: 'msg-9',
    });
    expect(restored.checkpoint.identity.checkpointId).toBe('from-snapshot');
    expect(restored.checkpoint.extensions.restoredFromIntentMessageId).toBe('msg-9');
    expect(restored.generation).toBe(3);
  });
});
