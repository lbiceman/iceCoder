import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackgroundTaskManager } from '../../src/tools/background-task-manager.js';
import type { BackgroundTaskSnapshot } from '../../src/types/runtime-checkpoint.js';

const isWindows = process.platform === 'win32';
function sleepCmd(seconds: number): string {
  return isWindows ? `ping -n ${seconds + 1} 127.0.0.1 > nul` : `sleep ${seconds}`;
}

describe('BackgroundTaskManager — exportSnapshot', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-snap-'));
    mgr = new BackgroundTaskManager(workDir, 'snap-test');
  });

  afterEach(() => mgr.dispose());

  it('returns empty array when no tasks', () => {
    expect(mgr.exportSnapshot()).toEqual([]);
  });

  it('exports running task with status=running', () => {
    const r = mgr.spawn(sleepCmd(30), 60_000, 'snap-running');
    const snap = mgr.exportSnapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].taskId).toBe(r.taskId);
    expect(snap[0].status).toBe('running');
    expect(snap[0].command).toBe(sleepCmd(30));
    expect(snap[0].label).toBe('snap-running');
    expect(snap[0].startedAt).toBeGreaterThan(0);
    expect(snap[0].endedAt).toBeNull();
    expect(snap[0].exitCode).toBeNull();
    expect(snap[0].logPath).toMatch(/snap-test/);
  });

  it('exports terminal tasks with correct status', async () => {
    writeFileSync(join(workDir, 'ok.cjs'), 'console.log("ok");\n', 'utf-8');
    mgr.spawn('node ok.cjs', 10_000, 'ok-task');
    await new Promise((r) => setTimeout(r, 2_500));

    const snap = mgr.exportSnapshot();
    const okTask = snap.find((s) => s.label === 'ok-task');
    expect(okTask).toBeDefined();
    expect(['completed', 'failed']).toContain(okTask!.status);
    expect(okTask!.endedAt).not.toBeNull();
  }, 15_000);
});

describe('BackgroundTaskManager — loadStaleSnapshot', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-stale-'));
    mgr = new BackgroundTaskManager(workDir, 'stale-mgr');
  });

  afterEach(() => mgr.dispose());

  it('loads a previously running snapshot as failed with [stale] error prefix', () => {
    const snap: BackgroundTaskSnapshot[] = [
      {
        taskId: 'bg_xyz123',
        command: 'npm test',
        label: 'npm test',
        status: 'running',
        startedAt: Date.now() - 60_000,
        endedAt: null,
        exitCode: null,
        error: null,
        totalOutputLines: 100,
        logPath: '/tmp/log.txt',
      },
    ];
    mgr.loadStaleSnapshot(snap);

    const status = mgr.getStatus('bg_xyz123');
    expect(status).not.toBeNull();
    expect(status!.status).toBe('failed');
    expect(status!.error).toMatch(/stale/i);
  });

  it('preserves already-terminal snapshot as-is', () => {
    const snap: BackgroundTaskSnapshot[] = [
      {
        taskId: 'bg_done',
        command: 'echo done',
        label: 'echo done',
        status: 'completed',
        startedAt: Date.now() - 5000,
        endedAt: Date.now() - 1000,
        exitCode: 0,
        error: null,
        totalOutputLines: 1,
        logPath: null,
      },
    ];
    mgr.loadStaleSnapshot(snap);

    const status = mgr.getStatus('bg_done');
    expect(status!.status).toBe('completed');
    expect(status!.exitCode).toBe(0);
    expect(status!.error).toBeNull();
  });

  it('skip when taskId already exists', () => {
    // 先用 spawn 创建
    const r = mgr.spawn(sleepCmd(30), 60_000, 'existing');
    const snap: BackgroundTaskSnapshot[] = [
      {
        taskId: r.taskId,
        command: 'should-not-overwrite',
        label: 'should-not-overwrite',
        status: 'failed',
        startedAt: 0,
        endedAt: 0,
        exitCode: null,
        error: 'fake error',
        totalOutputLines: 0,
        logPath: null,
      },
    ];
    mgr.loadStaleSnapshot(snap);

    const status = mgr.getStatus(r.taskId);
    expect(status!.label).toBe('existing');  // unchanged
    expect(status!.status).toBe('running');
  });

  it('roundtrip: exportSnapshot → loadStaleSnapshot keeps task identifiable', async () => {
    const r = mgr.spawn(sleepCmd(30), 60_000, 'roundtrip');
    const snap = mgr.exportSnapshot();

    const mgr2 = new BackgroundTaskManager(workDir, 'stale-mgr-2');
    try {
      mgr2.loadStaleSnapshot(snap);
      const s = mgr2.getStatus(r.taskId);
      expect(s).not.toBeNull();
      expect(s!.label).toBe('roundtrip');
      // The new manager sees it as failed (stale)
      expect(s!.status).toBe('failed');
      expect(s!.error).toMatch(/stale/i);
    } finally {
      mgr2.dispose();
    }
  });
});

describe('BackgroundTaskManager — taskStatusChanged signal (supervisor hook)', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-sup-'));
    mgr = new BackgroundTaskManager(workDir, 'sup-test');
  });

  afterEach(() => mgr.dispose());

  it('failure signal: subscribers can detect failed/timeout/killed', async () => {
    const failureSignals: string[] = [];
    mgr.on('taskStatusChanged', (s) => {
      if (s.status === 'failed' || s.status === 'timeout' || s.status === 'killed') {
        failureSignals.push(s.taskId);
      }
    });

    // killed
    const r = mgr.spawn(sleepCmd(30), 60_000, 'will-kill');
    await new Promise((res) => setTimeout(res, 200));
    mgr.kill(r.taskId);
    await new Promise((res) => setTimeout(res, 300));

    expect(failureSignals).toContain(r.taskId);
  }, 10_000);

  it('timeout fires failure signal', async () => {
    const failureSignals: string[] = [];
    mgr.on('taskStatusChanged', (s) => {
      if (s.status === 'timeout') failureSignals.push(s.taskId);
    });

    const r = mgr.spawn(sleepCmd(30), 1_000, 'will-timeout');
    await new Promise((res) => setTimeout(res, 5_000));

    expect(failureSignals).toContain(r.taskId);
  }, 12_000);
});
