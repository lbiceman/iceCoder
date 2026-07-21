/**
 * buildBgTaskSnapshot 测试
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getBackgroundTaskManagerFor,
  __resetBackgroundTaskManagers,
} from '../../src/tools/background-task-manager.js';
import { buildBgTaskSnapshot, buildBgTaskRunningSnapshot } from '../../src/web/bg-task-pusher.js';

afterEach(() => {
  __resetBackgroundTaskManagers();
});

describe('buildBgTaskSnapshot', () => {
  it('returns running tasks with command, elapsedMs', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-bg-snap-'));
    const mgr = getBackgroundTaskManagerFor('sess-snap', workDir);
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
    const { taskId } = mgr.spawn(cmd, 60_000, 'snap test');
    expect(taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 300));
    const snapshot = buildBgTaskSnapshot(mgr);
    expect(snapshot.length).toBeGreaterThanOrEqual(1);
    const row = snapshot.find((s) => s.taskId === taskId);
    expect(row).toBeTruthy();
    expect(row!.status).toBe('running');
    expect(row!.command).toContain(isWindows ? 'ping' : 'sleep');
    expect(row!.isTerminal).toBe(false);
    expect(row!.elapsedMs).toBeGreaterThan(0);

    mgr.kill(taskId);
  }, 10_000);

  it('includes terminal tasks before AUTO_CLEANUP', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-bg-snap-term-'));
    const mgr = getBackgroundTaskManagerFor('sess-snap-term', workDir);
    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? 'cmd /c exit 0'
      : 'true';
    const { taskId } = mgr.spawn(cmd, 60_000, 'quick job');
    expect(taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 800));
    expect(mgr.getStatus(taskId)?.status).toBe('completed');

    const snapshot = buildBgTaskSnapshot(mgr);
    const row = snapshot.find((s) => s.taskId === taskId);
    expect(row).toBeTruthy();
    expect(row!.isTerminal).toBe(true);
    expect(row!.status).toBe('completed');
    expect(row!.exitCode).toBe(0);
    expect(row!.elapsedMs).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it('buildBgTaskRunningSnapshot excludes terminal tasks', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-bg-snap-run-'));
    const mgr = getBackgroundTaskManagerFor('sess-snap-run', workDir);
    const isWindows = process.platform === 'win32';
    const quick = isWindows ? 'cmd /c exit 0' : 'true';
    const longCmd = isWindows ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
    mgr.spawn(quick, 60_000, 'quick');
    const { taskId: runningId } = mgr.spawn(longCmd, 60_000, 'long');
    await new Promise((r) => setTimeout(r, 800));

    const all = buildBgTaskSnapshot(mgr);
    const runningOnly = buildBgTaskRunningSnapshot(mgr);
    expect(all.length).toBeGreaterThan(runningOnly.length);
    expect(runningOnly.every((t) => t.status === 'running' && !t.isTerminal)).toBe(true);
    expect(runningOnly.some((t) => t.taskId === runningId)).toBe(true);

    mgr.kill(runningId);
  }, 10_000);
});
