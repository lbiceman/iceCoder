import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  BackgroundTaskManager,
  getBackgroundTaskManagerFor,
  getBackgroundTaskManager,
  __resetBackgroundTaskManagers,
} from '../../src/tools/background-task-manager.js';

const isWindows = process.platform === 'win32';

describe('BackgroundTaskManager — session isolation', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-session-'));
    __resetBackgroundTaskManagers();
  });

  afterEach(() => {
    __resetBackgroundTaskManagers();
  });

  it('same sessionId returns same manager instance', () => {
    const m1 = getBackgroundTaskManagerFor('session-A', workDir);
    const m2 = getBackgroundTaskManagerFor('session-A', workDir);
    expect(m1).toBe(m2);
    expect(m1.sessionId).toBe('session-A');
  });

  it('different sessionIds get different managers', () => {
    const mA = getBackgroundTaskManagerFor('session-A', workDir);
    const mB = getBackgroundTaskManagerFor('session-B', workDir);
    expect(mA).not.toBe(mB);
    expect(mA.sessionId).toBe('session-A');
    expect(mB.sessionId).toBe('session-B');
  });

  it('legacy getBackgroundTaskManager() maps to sessionId="default"', () => {
    const def = getBackgroundTaskManagerFor('default', workDir);
    const legacy = getBackgroundTaskManager(workDir);
    expect(def).toBe(legacy);
    expect(legacy.sessionId).toBe('default');
  });

  it('updates spawn cwd when workDir changes for same sessionId', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'ice-cwd-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'ice-cwd-b-'));

    const mgr = getBackgroundTaskManagerFor('session-cwd', dirA);
    expect(path.resolve(mgr.getWorkDir())).toBe(path.resolve(dirA));

    const same = getBackgroundTaskManagerFor('session-cwd', dirB);
    expect(same).toBe(mgr);
    expect(path.resolve(mgr.getWorkDir())).toBe(path.resolve(dirB));

    const marker = join(dirB, 'cwd-marker.txt');
    writeFileSync(marker, 'ok', 'utf-8');
    const cmd = isWindows
      ? 'type cwd-marker.txt'
      : 'cat cwd-marker.txt';

    const { taskId } = mgr.spawn(cmd, 5_000, 'cwd probe');
    expect(taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 1_500));

    const output = mgr.getOutput(taskId, 20);
    expect(output).toMatch(/ok/);
    mgr.dispose();
  }, 10_000);

  it('list() in session A does NOT show tasks from session B', () => {
    const mA = getBackgroundTaskManagerFor('session-A', workDir);
    const mB = getBackgroundTaskManagerFor('session-B', workDir);

    const cmd = isWindows ? 'echo hello-A' : 'echo hello-A';
    const rA = mA.spawn(cmd, 5_000, 'label-A');
    expect(rA.taskId).toBeTruthy();

    const listA = mA.list();
    const listB = mB.list();

    expect(listA.map(t => t.label)).toContain('label-A');
    expect(listB.map(t => t.label)).not.toContain('label-A');
  });
});

describe('BackgroundTaskManager — sessionId injection into child env', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-env-'));
    mgr = new BackgroundTaskManager(workDir, 'sess-xyz-123');
  });

  afterEach(() => mgr.dispose());

  it('child process receives ICE_AGENT_SESSION env var', async () => {
    // 直接验证 buildShellChildEnv 生成的 env 是否带有 sessionId，不依赖跨平台 cmd 转义
    const { buildShellChildEnv } = await import('../../src/tools/shell-host-guard.js');
    const env = buildShellChildEnv('sess-xyz-123');
    expect(env.ICE_AGENT_SESSION).toBe('sess-xyz-123');
    expect(env.ICE_AGENT_ROOT_PID).toBe(String(process.pid));
  });

  it('different managers inject different sessionIds (env propagation)', async () => {
    const { buildShellChildEnv } = await import('../../src/tools/shell-host-guard.js');
    const envA = buildShellChildEnv('aaa');
    const envB = buildShellChildEnv('bbb');
    expect(envA.ICE_AGENT_SESSION).toBe('aaa');
    expect(envB.ICE_AGENT_SESSION).toBe('bbb');
  });

  it('end-to-end: spawn with node script reads ICE_AGENT_SESSION', async () => {
    // cwd 已是 workDir，用相对路径避免 cmd 转义问题
    writeFileSync(
      join(workDir, 'probe.cjs'),
      'process.stdout.write(process.env.ICE_AGENT_SESSION || "<missing>");\n',
      'utf-8',
    );

    const r = mgr.spawn('node probe.cjs', 10_000, 'e2e-env');
    expect(r.taskId).toBeTruthy();

    await new Promise((r) => setTimeout(r, 3_000));

    const out = mgr.getOutput(r.taskId, 50);
    expect(out).toMatch(/sess-xyz-123/);
  }, 15_000);
});

describe('BackgroundTaskManager — process tree kill', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-kill-'));
    mgr = new BackgroundTaskManager(workDir, 'kill-test');
  });

  afterEach(() => mgr.dispose());

  it('kill() marks task as killed and clears child', async () => {
    // Long-running sleep
    const cmd = isWindows
      ? 'ping -n 60 127.0.0.1 > nul'
      : 'sleep 60';

    const result = mgr.spawn(cmd, 120_000, 'sleeping');
    expect(result.taskId).toBeTruthy();

    // ensure running
    await new Promise((r) => setTimeout(r, 500));
    expect(mgr.getStatus(result.taskId)?.status).toBe('running');

    const ok = mgr.kill(result.taskId);
    expect(ok).toBe(true);

    // Wait for kill grace + Windows taskkill async
    await new Promise((r) => setTimeout(r, 3_500));

    const status = mgr.getStatus(result.taskId);
    expect(status?.status).toBe('killed');
  }, 15_000);

  it('kill() on non-running task returns false', () => {
    expect(mgr.kill('bg_does_not_exist')).toBe(false);
  });

  it('hard timeout triggers process kill', async () => {
    const cmd = isWindows
      ? 'ping -n 60 127.0.0.1 > nul'
      : 'sleep 60';

    const result = mgr.spawn(cmd, 1_500, 'will-timeout');  // 1.5s hard timeout
    expect(result.taskId).toBeTruthy();

    // Wait for timeout + kill grace
    await new Promise((r) => setTimeout(r, 5_500));

    const status = mgr.getStatus(result.taskId);
    expect(status?.status).toBe('timeout');
    expect(status?.error).toMatch(/超时/);
  }, 12_000);

  it('dispose() cleans up tasks and stops timers', async () => {
    const cmd = isWindows
      ? 'ping -n 60 127.0.0.1 > nul'
      : 'sleep 60';

    const r1 = mgr.spawn(cmd, 60_000);
    const r2 = mgr.spawn(cmd, 60_000);
    expect(r1.taskId).toBeTruthy();
    expect(r2.taskId).toBeTruthy();
    expect(mgr.list().length).toBe(2);

    mgr.dispose();
    expect(mgr.list().length).toBe(0);
  }, 10_000);
});
