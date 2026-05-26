import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  composeBgStatusUserMessage,
  markBgSummaryEmitted,
  takeBgStatusForInjection,
} from '../../src/harness/harness-bg-summary.js';
import { BackgroundTaskManager } from '../../src/tools/background-task-manager.js';

const isWindows = process.platform === 'win32';
function sleepCmd(seconds: number): string {
  return isWindows ? `ping -n ${seconds + 1} 127.0.0.1 > nul` : `sleep ${seconds}`;
}

describe('harness-bg-summary — composeBgStatusUserMessage', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-hbs-'));
    mgr = new BackgroundTaskManager(workDir, 'hbs-test');
  });

  afterEach(() => mgr.dispose());

  it('returns null when no running tasks', () => {
    const result = composeBgStatusUserMessage('hbs-test', workDir, { manager: mgr });
    expect(result).toBeNull();
  });

  it('returns formatted block with taskIds when running task is due', () => {
    mgr.spawn(sleepCmd(30), 60_000, 'pending-job');

    const result = composeBgStatusUserMessage('hbs-test', workDir, {
      manager: mgr,
      intervalMs: 1,  // 立即 due
    });
    expect(result).not.toBeNull();
    expect(result!.content).toMatch(/Background Task Status/);
    expect(result!.content).toMatch(/pending-job/);
    expect(result!.taskIds.length).toBe(1);
    expect(result!.taskCount).toBe(1);
  });

  it('returns null on second call within interval (throttled)', () => {
    mgr.spawn(sleepCmd(30), 60_000, 'throttle-job');

    const first = takeBgStatusForInjection('hbs-test', workDir, {
      manager: mgr,
      intervalMs: 60_000,
    });
    expect(first).not.toBeNull();

    const second = takeBgStatusForInjection('hbs-test', workDir, {
      manager: mgr,
      intervalMs: 60_000,
    });
    expect(second).toBeNull();
  });

  it('honors maxChars truncation', () => {
    for (let i = 0; i < 5; i++) {
      mgr.spawn(sleepCmd(30), 60_000, `truncate-job-with-long-label-${i}`);
    }
    const result = composeBgStatusUserMessage('hbs-test', workDir, {
      manager: mgr,
      intervalMs: 1,
      maxChars: 150,
    });
    expect(result).not.toBeNull();
    expect(result!.content.length).toBeLessThanOrEqual(250);  // 包含 truncation hint
    expect(result!.content).toMatch(/more tasks/);
  });
});

describe('harness-bg-summary — markBgSummaryEmitted', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-hbs-mark-'));
    mgr = new BackgroundTaskManager(workDir, 'mark-test');
  });

  afterEach(() => mgr.dispose());

  it('emit + mark prevents re-emission until next interval', () => {
    mgr.spawn(sleepCmd(30), 60_000, 'one');

    const first = composeBgStatusUserMessage('mark-test', workDir, {
      manager: mgr,
      intervalMs: 60_000,
    });
    expect(first).not.toBeNull();

    markBgSummaryEmitted('mark-test', workDir, first!.taskIds, mgr);

    const second = composeBgStatusUserMessage('mark-test', workDir, {
      manager: mgr,
      intervalMs: 60_000,
    });
    expect(second).toBeNull();
  });

  it('takeBgStatusForInjection auto-marks emit', () => {
    mgr.spawn(sleepCmd(30), 60_000, 'auto-mark');

    const first = takeBgStatusForInjection('mark-test', workDir, {
      manager: mgr,
      intervalMs: 60_000,
    });
    expect(first).not.toBeNull();

    const second = takeBgStatusForInjection('mark-test', workDir, {
      manager: mgr,
      intervalMs: 60_000,
    });
    expect(second).toBeNull();
  });
});

describe('harness-bg-summary — stale reminder defense (CC #11716 防御)', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-hbs-stale-'));
    mgr = new BackgroundTaskManager(workDir, 'stale-test');
  });

  afterEach(() => mgr.dispose());

  it('task killed → no longer appears in subsequent summary', async () => {
    const r = mgr.spawn(sleepCmd(30), 60_000, 'will-die');

    const first = takeBgStatusForInjection('stale-test', workDir, {
      manager: mgr,
      intervalMs: 1,
    });
    expect(first).not.toBeNull();
    expect(first!).toMatch(/will-die/);

    mgr.kill(r.taskId);
    await new Promise((res) => setTimeout(res, 200));

    // dirty 标志已被设置但 status != running → 不应再注入
    const second = takeBgStatusForInjection('stale-test', workDir, {
      manager: mgr,
      intervalMs: 1,
    });
    expect(second).toBeNull();
  });

  it('task completed → no longer appears in subsequent summary', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(workDir, 'quick.cjs'),
      'console.log("instant");\n',
      'utf-8',
    );
    mgr.spawn('node quick.cjs', 10_000, 'instant-task');

    // 等到 task 完成
    await new Promise((res) => setTimeout(res, 2_500));

    const result = takeBgStatusForInjection('stale-test', workDir, {
      manager: mgr,
      intervalMs: 1,
    });
    // 已经 completed，不应注入
    expect(result).toBeNull();
  }, 15_000);
});
