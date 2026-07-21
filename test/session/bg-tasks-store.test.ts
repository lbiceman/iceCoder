/**
 * bg-tasks-store 测试
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readSessionBgTasks,
  writeSessionBgTasks,
  clearSessionBgTasks,
  syncSessionBgTasksFromManager,
} from '../../src/session/bg-tasks-store.js';
import {
  getBackgroundTaskManagerFor,
  __resetBackgroundTaskManagers,
} from '../../src/tools/background-task-manager.js';

afterEach(() => {
  __resetBackgroundTaskManagers();
});

describe('bg-tasks-store', () => {
  it('write/read/clear session bg tasks file', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'ice-bg-store-'));
    const tasks = [{
      taskId: 'bg_test1',
      label: 'job',
      status: 'running' as const,
      elapsed: '1s',
      elapsedMs: 1000,
      newLines: 0,
      isTerminal: false,
      isHang: false,
    }];
    await writeSessionBgTasks(sessionsDir, 'sess-a', tasks);
    expect(await readSessionBgTasks(sessionsDir, 'sess-a')).toHaveLength(1);
    await clearSessionBgTasks(sessionsDir, 'sess-a');
    expect(await readSessionBgTasks(sessionsDir, 'sess-a')).toEqual([]);
  });

  it('syncSessionBgTasksFromManager persists running tasks', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'ice-bg-sync-'));
    const workDir = mkdtempSync(join(tmpdir(), 'ice-bg-sync-wd-'));
    const mgr = getBackgroundTaskManagerFor('sess-sync', workDir);
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
    const { taskId } = mgr.spawn(cmd, 60_000, 'sync job');
    expect(taskId).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));

    const synced = await syncSessionBgTasksFromManager(sessionsDir, 'sess-sync', workDir);
    expect(synced.some((t) => t.taskId === taskId)).toBe(true);
    const loaded = await readSessionBgTasks(sessionsDir, 'sess-sync');
    expect(loaded.some((t) => t.taskId === taskId)).toBe(true);

    mgr.kill(taskId);
    await syncSessionBgTasksFromManager(sessionsDir, 'sess-sync', workDir);
    expect(await readSessionBgTasks(sessionsDir, 'sess-sync')).toEqual([]);
  }, 10_000);
});
