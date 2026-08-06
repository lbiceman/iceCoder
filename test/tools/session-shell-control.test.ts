/**
 * stopAllShellWorkForSession / killAllRunning 测试
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  getBackgroundTaskManagerFor,
  __resetBackgroundTaskManagers,
} from '../../src/tools/background-task-manager.js';
import {
  __resetForegroundShellRegistry,
  registerForegroundShell,
  killForegroundShellsForSession,
} from '../../src/tools/foreground-shell-registry.js';
import {
  stopAllShellWorkForSession,
  stopForegroundShellWorkForSession,
  killCopilotInteractiveShellsForSession,
} from '../../src/tools/session-shell-control.js';
import {
  getInteractiveShellManagerFor,
  __resetInteractiveShellManagers,
} from '../../src/tools/interactive-shell-manager.js';

const isWindows = process.platform === 'win32';

afterEach(() => {
  __resetBackgroundTaskManagers();
  __resetForegroundShellRegistry();
  __resetInteractiveShellManagers();
});

describe('stopAllShellWorkForSession', () => {
  it('stopAllShellWorkForSession 终止运行中 detached 后台任务', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-shell-stop-'));
    const mgr = getBackgroundTaskManagerFor('sess-stop', workDir);

    const cmd = isWindows
      ? 'ping -n 60 127.0.0.1 > nul'
      : 'sleep 60';
    const { taskId } = mgr.spawn(cmd, 120_000, 'long job');
    expect(taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));
    expect(mgr.getStatus(taskId)?.status).toBe('running');

    const result = stopAllShellWorkForSession('sess-stop', 'test');
    expect(result.background).toBe(1);

    await new Promise((r) => setTimeout(r, 3_500));
    expect(mgr.getStatus(taskId)?.status).toBe('killed');
  }, 15_000);

  it('stopForegroundShellWorkForSession 不杀 detached 后台任务', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-shell-fg-bg-'));
    const mgr = getBackgroundTaskManagerFor('sess-fg-bg', workDir);

    const cmd = isWindows
      ? 'ping -n 60 127.0.0.1 > nul'
      : 'sleep 60';
    const { taskId } = mgr.spawn(cmd, 120_000, 'long job');
    expect(taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));
    expect(mgr.getStatus(taskId)?.status).toBe('running');

    const result = stopForegroundShellWorkForSession('sess-fg-bg', 'test');
    expect(result.foreground).toBe(0);
    expect(mgr.getStatus(taskId)?.status).toBe('running');
  }, 15_000);

  it('未知 session 返回 0', () => {
    const result = stopAllShellWorkForSession('no-such-session', 'test');
    expect(result.background).toBe(0);
    expect(result.foreground).toBe(0);
    expect(result.interactiveShell).toBe(0);
  });

  it('killForegroundShellsForSession 终止前台 shell', async () => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellArgs = isWindows
      ? ['/c', 'ping -n 60 127.0.0.1 > nul']
      : ['-c', 'sleep 60'];

    const child = spawn(shell, shellArgs, { stdio: 'ignore', windowsHide: true });
    registerForegroundShell('sess-fg', child, 'sleep probe');

    await new Promise((r) => setTimeout(r, 400));
    expect(child.pid).toBeTruthy();

    const killed = killForegroundShellsForSession('sess-fg');
    expect(killed).toBe(1);

    await new Promise((r) => setTimeout(r, 3_500));
    expect(child.killed || child.exitCode !== null).toBe(true);
  }, 15_000);

  it('spawn 默认 lifespan=detached', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-shell-lifespan-'));
    const mgr = getBackgroundTaskManagerFor('sess-lifespan', workDir);
    const cmd = isWindows ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30';
    const { taskId } = mgr.spawn(cmd, 60_000, 'detached job');
    expect(mgr.getStatus(taskId)?.lifespan).toBe('detached');
    mgr.kill(taskId);
  }, 10_000);

  it('killAllRunning({ lifespan: bound }) 仅杀 bound，保留 detached', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-shell-bound-filter-'));
    const mgr = getBackgroundTaskManagerFor('sess-bound-filter', workDir);
    const cmd = isWindows ? 'ping -n 60 127.0.0.1 > nul' : 'sleep 60';

    const detached = mgr.spawn(cmd, 120_000, 'detached job', 'detached');
    const bound = mgr.spawn(cmd, 120_000, 'bound job', 'bound');
    expect(detached.taskId).toBeTruthy();
    expect(bound.taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));
    expect(mgr.getStatus(detached.taskId)?.status).toBe('running');
    expect(mgr.getStatus(bound.taskId)?.status).toBe('running');

    const killed = mgr.killAllRunning({ lifespan: 'bound' });
    expect(killed).toBe(1);

    await new Promise((r) => setTimeout(r, 3_500));
    expect(mgr.getStatus(detached.taskId)?.status).toBe('running');
    expect(mgr.getStatus(bound.taskId)?.status).toBe('killed');

    mgr.kill(detached.taskId);
  }, 20_000);
});

describe('copilot interactive shell lifespan (任务 1.4)', () => {
  const longCmd = isWindows
    ? 'ping -n 60 127.0.0.1 > nul'
    : 'sleep 60';

  it('T6: stopForegroundShellWorkForSession 不杀 copilot PTY', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-stop-fg-'));
    const ishMgr = getInteractiveShellManagerFor('sess-ish-fg', workDir);
    const { taskId } = ishMgr.start({ command: longCmd });
    expect(taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));
    expect(ishMgr.getActiveTask()?.status).toBe('running');

    const result = stopForegroundShellWorkForSession('sess-ish-fg', 'Stop Agent');
    expect(result.background).toBe(0);
    expect(ishMgr.getActiveTask()?.status).toBe('running');

    ishMgr.stop(taskId);
  }, 15_000);

  it('T7: stopAllShellWorkForSession 终止 copilot PTY', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-stop-all-'));
    const ishMgr = getInteractiveShellManagerFor('sess-ish-all', workDir);
    const { taskId } = ishMgr.start({ command: longCmd });
    expect(taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));
    expect(ishMgr.getActiveTask()?.status).toBe('running');

    const result = stopAllShellWorkForSession('sess-ish-all', 'session delete');
    expect(result.interactiveShell).toBe(1);

    expect(ishMgr.getActiveTask()).toBeNull();
    // dispose 已清空 task 表；PTY 已在 kill 阶段终止
    expect(ishMgr.getTask(taskId)).toBeNull();
  }, 15_000);

  it('killCopilotInteractiveShellsForSession 可供 session 删除清理 PTY', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'ice-ish-exit-'));
    const ishMgr = getInteractiveShellManagerFor('sess-ish-exit', workDir);
    const { taskId } = ishMgr.start({ command: longCmd });
    expect(taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 500));
    expect(ishMgr.getActiveTask()?.status).toBe('running');

    const killed = killCopilotInteractiveShellsForSession('sess-ish-exit', 'session cleanup');
    expect(killed).toBe(1);
    expect(ishMgr.getTask(taskId)?.status).toBe('killed');
  }, 15_000);
});
