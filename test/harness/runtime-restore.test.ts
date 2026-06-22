import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CheckpointEngine } from '../../src/harness/checkpoint-engine.js';
import { captureIntentCheckpoint } from '../../src/harness/intent-checkpoint-capture.js';
import {
  loadCheckpointIndex,
  loadIntentCheckpoint,
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
} from '../../src/harness/intent-checkpoint-turn-snapshot.js';
import { emptyRuntimeCheckpointV2 } from '../../src/types/runtime-checkpoint.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ice-restore-'));
}

describe('RuntimeRestoreCoordinator', () => {
  let tmp: string;
  const sessionId = 'sess-restore';

  beforeEach(async () => {
    tmp = await makeTempDir();
    resetHarnessRuntimeRegistry();
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
        verificationRequired: false,
        verificationStatus: 'not_required' as const,
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
    const result = await coordinator.restore({
      sessionDir: tmp,
      sessionId,
      messageId,
      defaultWorkDir: tmp,
    });

    expect(result.systemEventContent).toContain('运行时已成功恢复');

    const uiRaw = JSON.parse(await fs.readFile(path.join(tmp, `${sessionId}.json`), 'utf-8'));
    expect(uiRaw).toHaveLength(1);
    expect(uiRaw[0].id).toBe(messageId);

    const index = await loadCheckpointIndex(tmp, sessionId);
    expect(index.cursorMessageId).toBe(messageId);
    expect(index.entries).toHaveLength(1);

    const archive = await loadIntentCheckpoint(tmp, sessionId, messageId);
    expect(archive?.messageId).toBe(messageId);
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
        verificationRequired: false,
        verificationStatus: 'not_required' as const,
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
