import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearShellCollab,
  getShellCollabState,
  loadForSession,
  persist,
  resetShellCollabStoreForTests,
  setShellCollabActive,
  buildShellCollabActiveIndex,
  resolveShellCollabActive,
} from '../../src/session/shell-collab-store.js';
import { purgeSessionDiskFiles } from '../../src/web/session-file-purge.js';

describe('shell-collab-store', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    resetShellCollabStoreForTests();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    tempDir = undefined;
  });

  it('persists active state and restores it after a simulated restart', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-collab-'));
    const sessionId = 'session-a';

    const entered = await setShellCollabActive(sessionId, true, tempDir);
    expect(entered).toMatchObject({ active: true, taskId: null });
    expect(entered.enteredAt).toBeGreaterThan(0);

    entered.taskId = 'ish_test';
    await persist(sessionId, tempDir);
    resetShellCollabStoreForTests();
    expect(getShellCollabState(sessionId)).toBeUndefined();

    const restored = await loadForSession(sessionId, tempDir);
    expect(restored).toEqual({
      active: true,
      taskId: 'ish_test',
      enteredAt: entered.enteredAt,
    });
    expect(getShellCollabState(sessionId)).toEqual(restored);
  });

  it('keeps enteredAt and taskId when entering an active session again', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-collab-'));
    const first = await setShellCollabActive('session-b', true, tempDir);
    first.taskId = 'ish_existing';
    await persist('session-b', tempDir);

    const second = await setShellCollabActive('session-b', true, tempDir);
    expect(second).toEqual({
      active: true,
      taskId: 'ish_existing',
      enteredAt: first.enteredAt,
    });
  });

  it('does not allow an active session to revert to normal mode', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-collab-'));
    const first = await setShellCollabActive('session-fixed', true, tempDir);
    first.taskId = 'ish_fixed';
    await persist('session-fixed', tempDir);

    const attemptedExit = await setShellCollabActive('session-fixed', false, tempDir);
    expect(attemptedExit).toEqual({
      active: true,
      taskId: 'ish_fixed',
      enteredAt: first.enteredAt,
    });

    resetShellCollabStoreForTests();
    await expect(loadForSession('session-fixed', tempDir)).resolves.toMatchObject({
      active: true,
      taskId: 'ish_fixed',
    });
  });

  it('clears both memory state and sidecar', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-collab-'));
    const sessionId = 'session-c';
    const sidecar = path.join(tempDir, `${sessionId}.shell-collab.json`);
    await setShellCollabActive(sessionId, true, tempDir);

    await clearShellCollab(sessionId, tempDir);

    expect(getShellCollabState(sessionId)).toBeUndefined();
    await expect(fs.access(sidecar)).rejects.toThrow();
  });

  it('session purge clears the in-memory state and sidecar', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-collab-'));
    const sessionId = 'session-d';
    const sidecar = path.join(tempDir, `${sessionId}.shell-collab.json`);
    await setShellCollabActive(sessionId, true, tempDir);

    await purgeSessionDiskFiles(tempDir, sessionId);

    expect(getShellCollabState(sessionId)).toBeUndefined();
    await expect(fs.access(sidecar)).rejects.toThrow();
  });

  it('buildShellCollabActiveIndex returns only active sessions', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-collab-'));
    await setShellCollabActive('session-a', true, tempDir);
    await setShellCollabActive('session-b', false, tempDir);
    resetShellCollabStoreForTests();

    const index = await buildShellCollabActiveIndex(['session-a', 'session-b', 'session-c'], tempDir);
    expect(index).toEqual({ 'session-a': true });
  });

  it('resolveShellCollabActive restores sidecar after memory reset (simulated restart)', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-collab-'));
    await setShellCollabActive('session-restart', true, tempDir);
    resetShellCollabStoreForTests();
    expect(getShellCollabState('session-restart')).toBeUndefined();

    await expect(resolveShellCollabActive('session-restart', tempDir)).resolves.toBe(true);
    expect(getShellCollabState('session-restart')?.active).toBe(true);
  });

  it('resolveShellCollabActive returns false when sidecar missing', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-shell-collab-'));
    await expect(resolveShellCollabActive('missing-session', tempDir)).resolves.toBe(false);
  });
});
