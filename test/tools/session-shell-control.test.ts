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
import { stopAllShellWorkForSession } from '../../src/tools/session-shell-control.js';

const isWindows = process.platform === 'win32';

afterEach(() => {
  __resetBackgroundTaskManagers();
  __resetForegroundShellRegistry();
});

describe('stopAllShellWorkForSession', () => {
  it('killAllRunning 终止运行中后台任务', async () => {
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

  it('未知 session 返回 0', () => {
    const result = stopAllShellWorkForSession('no-such-session', 'test');
    expect(result.background).toBe(0);
    expect(result.foreground).toBe(0);
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
});
