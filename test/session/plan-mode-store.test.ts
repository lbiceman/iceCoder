import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clearPlanMode,
  getPlanModeState,
  loadPlanModeForSession,
  persistPlanMode,
  resetPlanModeStoreForTests,
  setPlanModeActive,
  buildPlanModeActiveIndex,
  resolvePlanModeActive,
} from '../../src/session/plan-mode-store.js';
import { purgeSessionDiskFiles } from '../../src/web/session-file-purge.js';

describe('plan-mode-store', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    resetPlanModeStoreForTests();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    tempDir = undefined;
  });

  it('persists active state and restores it after a simulated restart', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-plan-mode-'));
    const sessionId = 'session-a';

    const entered = await setPlanModeActive(sessionId, true, tempDir);
    expect(entered).toMatchObject({ active: true });
    expect(entered.enteredAt).toBeGreaterThan(0);

    resetPlanModeStoreForTests();
    expect(getPlanModeState(sessionId)).toBeUndefined();

    const restored = await loadPlanModeForSession(sessionId, tempDir);
    expect(restored).toEqual({
      active: true,
      enteredAt: entered.enteredAt,
    });
    expect(getPlanModeState(sessionId)).toEqual(restored);
  });

  it('keeps enteredAt when entering an active session again', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-plan-mode-'));
    const first = await setPlanModeActive('session-b', true, tempDir);
    const second = await setPlanModeActive('session-b', true, tempDir);
    expect(second).toEqual({
      active: true,
      enteredAt: first.enteredAt,
    });
  });

  it('keeps in-memory active state when sidecar is temporarily missing', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-plan-mode-'));
    const sessionId = 'session-race';
    await setPlanModeActive(sessionId, true, tempDir);
    await fs.unlink(path.join(tempDir, `${sessionId}.plan-mode.json`));

    const loaded = await loadPlanModeForSession(sessionId, tempDir);
    expect(loaded?.active).toBe(true);
    expect(getPlanModeState(sessionId)?.active).toBe(true);
  });

  it('allows an active session to exit plan mode', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-plan-mode-'));
    const first = await setPlanModeActive('session-exit', true, tempDir);
    const exited = await setPlanModeActive('session-exit', false, tempDir);
    expect(exited.active).toBe(false);
    expect(exited.enteredAt).toBe(first.enteredAt);
    expect(getPlanModeState('session-exit')).toBeUndefined();
    await expect(fs.access(path.join(tempDir, 'session-exit.plan-mode.json'))).rejects.toThrow();

    resetPlanModeStoreForTests();
    await expect(resolvePlanModeActive('session-exit', tempDir)).resolves.toBe(false);
  });

  it('clears both memory state and sidecar', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-plan-mode-'));
    const sessionId = 'session-c';
    const sidecar = path.join(tempDir, `${sessionId}.plan-mode.json`);
    await setPlanModeActive(sessionId, true, tempDir);
    await persistPlanMode(sessionId, tempDir);

    await clearPlanMode(sessionId, tempDir);

    expect(getPlanModeState(sessionId)).toBeUndefined();
    await expect(fs.access(sidecar)).rejects.toThrow();
  });

  it('session purge clears the in-memory state and sidecar', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-plan-mode-'));
    const sessionId = 'session-d';
    const sidecar = path.join(tempDir, `${sessionId}.plan-mode.json`);
    await setPlanModeActive(sessionId, true, tempDir);

    await purgeSessionDiskFiles(tempDir, sessionId);

    expect(getPlanModeState(sessionId)).toBeUndefined();
    await expect(fs.access(sidecar)).rejects.toThrow();
  });

  it('buildPlanModeActiveIndex returns only active sessions', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-plan-mode-'));
    await setPlanModeActive('session-a', true, tempDir);
    await setPlanModeActive('session-b', false, tempDir);
    resetPlanModeStoreForTests();

    const index = await buildPlanModeActiveIndex(['session-a', 'session-b', 'session-c'], tempDir);
    expect(index).toEqual({ 'session-a': true });
  });
});
