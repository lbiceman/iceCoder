import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { IntentCheckpointArchive } from '../../src/types/intent-checkpoint.js';
import {
  collectSessionTouchedPaths,
  loadCheckpointIndex,
  removeCheckpoint,
  saveIntentCheckpoint,
  touchSessionTouchedPaths,
  truncateCheckpointsAfter,
} from '../../src/harness/intent-checkpoint-store.js';

function makeArchive(
  sessionId: string,
  messageId: string,
  trackedPaths: string[],
): IntentCheckpointArchive {
  return {
    version: 1,
    messageId,
    sessionId,
    createdAt: new Date().toISOString(),
    userMessageTime: null,
    workspace: { referenceReads: [], changeCount: 0 },
    workspaceRoot: '/tmp',
    workspaceFiles: {},
    trackedPaths,
    uiMessages: [],
    structuredMessages: [],
  };
}

describe('sessionTouchedPaths', () => {
  it('collectSessionTouchedPaths 覆盖写入与 fs_operation，忽略 list/read', () => {
    expect(collectSessionTouchedPaths('write_file', { path: 'src/a.ts' })).toEqual(['src/a.ts']);
    expect(collectSessionTouchedPaths('read_file', { path: 'src/a.ts' })).toEqual([]);
    expect(collectSessionTouchedPaths('fs_operation', { operation: 'list', path: 'src' })).toEqual([]);
    expect(collectSessionTouchedPaths('fs_operation', { operation: 'delete', path: 'old.ts' })).toEqual(['old.ts']);
    expect(collectSessionTouchedPaths('fs_operation', {
      operation: 'move',
      path: 'a.ts',
      target: 'b.ts',
    })).toEqual(['a.ts', 'b.ts']);
  });

  it('保存检查点不会把归档提示路径并进 live manifest', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-touched-save-'));
    const sessionId = 's1';
    try {
      await touchSessionTouchedPaths(sessionDir, sessionId, ['src/written.ts']);
      await saveIntentCheckpoint({
        sessionDir,
        sessionId,
        archive: makeArchive(sessionId, 'u1', ['src/written.ts', 'docs/only-mentioned.md']),
      });
      const index = await loadCheckpointIndex(sessionDir, sessionId);
      expect(index.sessionTouchedPaths).toEqual(['src/written.ts']);
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('删除消息不回滚工作区，故保留 live 写入清单', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-touched-del-'));
    const sessionId = 's1';
    try {
      await saveIntentCheckpoint({
        sessionDir,
        sessionId,
        archive: makeArchive(sessionId, 'u1', ['src/old.ts']),
      });
      await saveIntentCheckpoint({
        sessionDir,
        sessionId,
        archive: makeArchive(sessionId, 'u2', ['src/old.ts']),
      });
      await touchSessionTouchedPaths(sessionDir, sessionId, ['src/old.ts', 'src/live.ts']);
      await removeCheckpoint(sessionDir, sessionId, 'u1');
      const index = await loadCheckpointIndex(sessionDir, sessionId);
      expect(index.cursorMessageId).toBe('u2');
      expect(index.cursorRestored).toBe(false);
      expect(index.sessionTouchedPaths).toEqual(['src/old.ts', 'src/live.ts']);
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('回滚截断只保留 live 与 cursor 归档的交集', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-touched-rst-'));
    const sessionId = 's1';
    try {
      await saveIntentCheckpoint({
        sessionDir,
        sessionId,
        archive: makeArchive(sessionId, 'u1', ['src/keep.ts', 'docs/hint.md']),
      });
      await saveIntentCheckpoint({
        sessionDir,
        sessionId,
        archive: makeArchive(sessionId, 'u2', ['src/keep.ts', 'src/later.ts']),
      });
      await touchSessionTouchedPaths(sessionDir, sessionId, [
        'src/keep.ts',
        'src/later.ts',
        'src/current-turn.ts',
      ]);
      await truncateCheckpointsAfter(sessionDir, sessionId, 'u1');
      const index = await loadCheckpointIndex(sessionDir, sessionId);
      expect(index.cursorMessageId).toBe('u1');
      expect(index.cursorRestored).toBe(true);
      expect(index.sessionTouchedPaths).toEqual(['src/keep.ts']);
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });

  it('并行 touch 不会丢路径', async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-touched-race-'));
    const sessionId = 's1';
    try {
      await Promise.all([
        touchSessionTouchedPaths(sessionDir, sessionId, ['a.ts']),
        touchSessionTouchedPaths(sessionDir, sessionId, ['b.ts']),
        touchSessionTouchedPaths(sessionDir, sessionId, ['c.ts']),
      ]);
      const index = await loadCheckpointIndex(sessionDir, sessionId);
      expect(new Set(index.sessionTouchedPaths)).toEqual(new Set(['a.ts', 'b.ts', 'c.ts']));
    } finally {
      await fs.rm(sessionDir, { recursive: true, force: true });
    }
  });
});
