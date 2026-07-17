import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackgroundTaskManager } from '../../src/tools/background-task-manager.js';

const isWindows = process.platform === 'win32';

function sleepCmd(seconds: number): string {
  return isWindows ? `ping -n ${seconds + 1} 127.0.0.1 > nul` : `sleep ${seconds}`;
}

async function waitForTaskStatus(
  mgr: BackgroundTaskManager,
  taskId: string,
  status: 'completed' | 'failed' | 'running',
): Promise<void> {
  await expect.poll(
    () => mgr.getStatus(taskId)?.status,
    { timeout: 12_000, interval: 50 },
  ).toBe(status);
}

async function waitForOutput(
  mgr: BackgroundTaskManager,
  taskId: string,
  pattern: RegExp,
): Promise<void> {
  await expect.poll(
    () => mgr.getOutputSince(taskId, 0)?.output || '',
    { timeout: 12_000, interval: 50 },
  ).toMatch(pattern);
}

describe('BackgroundTaskManager — getOutputSince (diff-only check)', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-since-'));
    mgr = new BackgroundTaskManager(workDir, 'diff-test');
  });

  afterEach(() => mgr.dispose());

  it('returns null for non-existent task', () => {
    expect(mgr.getOutputSince('bg_missing', 0)).toBeNull();
  });

  it('returns full output when since=0', async () => {
    // 写一个脚本：打印 5 行，立刻退出
    writeFileSync(
      join(workDir, 'printer.cjs'),
      'for (let i = 1; i <= 5; i++) console.log("line " + i);\n',
      'utf-8',
    );
    const r = mgr.spawn('node printer.cjs', 10_000, 'printer');
    expect(r.taskId).toBeTruthy();

    await waitForOutput(mgr, r.taskId, /line 5/);
    await waitForTaskStatus(mgr, r.taskId, 'completed');

    const result = mgr.getOutputSince(r.taskId, 0);
    expect(result).not.toBeNull();
    expect(result!.output).toMatch(/line 1/);
    expect(result!.output).toMatch(/line 5/);
    expect(result!.cursor).toBeGreaterThan(0);
    expect(result!.truncated).toBe(false);
  }, 15_000);

  it('returns empty output when since=cursor (no new data)', async () => {
    writeFileSync(
      join(workDir, 'printer2.cjs'),
      'for (let i = 1; i <= 3; i++) console.log("line " + i);\n',
      'utf-8',
    );
    const r = mgr.spawn('node printer2.cjs', 10_000, 'printer2');
    await waitForOutput(mgr, r.taskId, /line 3/);
    await waitForTaskStatus(mgr, r.taskId, 'completed');

    const first = mgr.getOutputSince(r.taskId, 0);
    const second = mgr.getOutputSince(r.taskId, first!.cursor);

    expect(second).not.toBeNull();
    expect(second!.output).toBe('');
    expect(second!.cursor).toBe(first!.cursor);
    expect(second!.truncated).toBe(false);
  }, 15_000);

  it('returns only new lines between two checks', async () => {
    // 用一个慢一点的脚本（每行 sleep 一下）
    writeFileSync(
      join(workDir, 'slow.cjs'),
      `
const { existsSync } = require('node:fs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 1; i <= 2; i++) {
    console.log("slow line " + i);
  }
  while (!existsSync('slow-release.signal')) await sleep(25);
  for (let i = 3; i <= 5; i++) console.log("slow line " + i);
})();
`,
      'utf-8',
    );
    const r = mgr.spawn('node slow.cjs', 30_000, 'slow');
    expect(r.taskId).toBeTruthy();

    await waitForOutput(mgr, r.taskId, /slow line 2/);
    const first = mgr.getOutputSince(r.taskId, 0);
    const firstCursor = first!.cursor;
    expect(first!.output).toMatch(/slow line 1/);

    writeFileSync(join(workDir, 'slow-release.signal'), 'release', 'utf-8');
    await waitForOutput(mgr, r.taskId, /slow line 5/);
    await waitForTaskStatus(mgr, r.taskId, 'completed');

    const second = mgr.getOutputSince(r.taskId, firstCursor);
    expect(second).not.toBeNull();
    expect(second!.output).toMatch(/slow line 5/);
    expect(second!.cursor).toBeGreaterThan(firstCursor);
    // first 里的 line 1 不应出现在 second 里
    expect(second!.output).not.toMatch(/slow line 1\b/);
  }, 15_000);

  it('truncated=true when since predates the ring buffer', async () => {
    // 直接构造一个 task，手动塞 600 行（超过 MAX_OUTPUT_LINES=500）
    writeFileSync(
      join(workDir, 'flood.cjs'),
      'for (let i = 1; i <= 600; i++) console.log("flood " + i);\n',
      'utf-8',
    );
    const r = mgr.spawn('node flood.cjs', 10_000, 'flood');
    await expect.poll(
      () => mgr.getOutputSince(r.taskId, 50)?.truncated,
      { timeout: 12_000, interval: 50 },
    ).toBe(true);

    const result = mgr.getOutputSince(r.taskId, 50);  // since=50 应被环形缓冲外
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
  }, 15_000);
});

describe('BackgroundTaskManager — log file persistence', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-log-'));
    mgr = new BackgroundTaskManager(workDir, 'log-test');
  });

  afterEach(() => mgr.dispose());

  it('writes output to data/sessions/{sid}/bg/{tid}.log', async () => {
    writeFileSync(
      join(workDir, 'logged.cjs'),
      'console.log("hello-to-log"); console.error("err-to-log");\n',
      'utf-8',
    );
    const r = mgr.spawn('node logged.cjs', 10_000);

    const expectedPath = join(workDir, 'data', 'sessions', 'log-test', 'bg', `${r.taskId}.log`);
    await expect.poll(
      () => existsSync(expectedPath) ? readFileSync(expectedPath, 'utf-8') : '',
      { timeout: 12_000, interval: 50 },
    ).toMatch(/hello-to-log[\s\S]*err-to-log|err-to-log[\s\S]*hello-to-log/);
    expect(existsSync(expectedPath)).toBe(true);

    const content = readFileSync(expectedPath, 'utf-8');
    expect(content).toMatch(/hello-to-log/);
    expect(content).toMatch(/err-to-log/);
  }, 15_000);

  it('different sessions write to different log paths', async () => {
    const m1 = new BackgroundTaskManager(workDir, 'sess-1');
    const m2 = new BackgroundTaskManager(workDir, 'sess-2');
    try {
      writeFileSync(join(workDir, 'a.cjs'), 'console.log("aaa");\n', 'utf-8');
      const r1 = m1.spawn('node a.cjs', 10_000);
      const r2 = m2.spawn('node a.cjs', 10_000);

      const p1 = join(workDir, 'data', 'sessions', 'sess-1', 'bg', `${r1.taskId}.log`);
      const p2 = join(workDir, 'data', 'sessions', 'sess-2', 'bg', `${r2.taskId}.log`);
      await expect.poll(
        () => [p1, p2].every((file) => existsSync(file) && readFileSync(file, 'utf-8').includes('aaa')),
        { timeout: 12_000, interval: 50 },
      ).toBe(true);
      expect(existsSync(p1)).toBe(true);
      expect(existsSync(p2)).toBe(true);
    } finally {
      m1.dispose();
      m2.dispose();
    }
  }, 15_000);
});

describe('BackgroundTaskManager — getRunningSummary + markSummaryEmitted', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-summary-'));
    mgr = new BackgroundTaskManager(workDir, 'summary-test');
  });

  afterEach(() => mgr.dispose());

  it('returns all running tasks when onlyDirtyOrDue=false', () => {
    const r1 = mgr.spawn(sleepCmd(20), 60_000, 'sleeper-1');
    const r2 = mgr.spawn(sleepCmd(20), 60_000, 'sleeper-2');

    const all = mgr.getRunningSummary({ onlyDirtyOrDue: false });
    const ids = all.map((s) => s.taskId).sort();
    expect(ids).toContain(r1.taskId);
    expect(ids).toContain(r2.taskId);
    expect(all.every((s) => s.status === 'running')).toBe(true);
    expect(all.every((s) => !s.isTerminal)).toBe(true);
  });

  it('returns due tasks when onlyDirtyOrDue=true and interval elapsed', () => {
    mgr.spawn(sleepCmd(20), 60_000, 'due-task');

    // 首次：lastSummaryEmittedAt=0 → due
    const first = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs: 5_000 });
    expect(first.length).toBe(1);

    // mark emitted
    mgr.markSummaryEmitted(first.map((s) => s.taskId));

    // 立刻再查：interval 未到 → 应当空
    const second = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs: 60_000 });
    expect(second.length).toBe(0);
  });

  it('marks task dirty on status change (kill triggers immediate re-emit candidate)', async () => {
    const r = mgr.spawn(sleepCmd(20), 60_000, 'dirty-task');
    // first: due (lastEmittedAt=0)
    const first = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs: 5_000 });
    expect(first.length).toBe(1);
    mgr.markSummaryEmitted([r.taskId]);

    // kill — should mark dirty even though interval not elapsed
    mgr.kill(r.taskId);

    // But now task is no longer 'running' — getRunningSummary should NOT include it
    const second = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs: 60_000 });
    expect(second.find((s) => s.taskId === r.taskId)).toBeUndefined();
  });

  it('newLinesSinceLastSummary reflects output delta', async () => {
    writeFileSync(
      join(workDir, 'output3.cjs'),
      `
const { existsSync } = require('node:fs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 1; i <= 4; i++) console.log("burst " + i);
  while (!existsSync('summary-release.signal')) await sleep(25);
  for (let i = 5; i <= 10; i++) console.log("burst " + i);
  while (!existsSync('summary-finish.signal')) await sleep(25);
})();
`,
      'utf-8',
    );
    const r = mgr.spawn('node output3.cjs', 30_000);
    await waitForOutput(mgr, r.taskId, /burst 4/);

    const first = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs: 1 });
    const firstSummary = first.find((s) => s.taskId === r.taskId);
    expect(firstSummary).toBeDefined();
    const firstCount = firstSummary!.newLinesSinceLastSummary;
    expect(firstCount).toBeGreaterThan(0);

    mgr.markSummaryEmitted([r.taskId]);

    writeFileSync(join(workDir, 'summary-release.signal'), 'release', 'utf-8');
    await waitForOutput(mgr, r.taskId, /burst 10/);

    const second = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs: 1 });
    const secondSummary = second.find((s) => s.taskId === r.taskId);
    expect(secondSummary).toBeDefined();
    expect(secondSummary!.newLinesSinceLastSummary).toBeGreaterThan(0);
    // emit 后 lastEmittedTotalCache 重置；第二次只算 emit 之后的新增
    expect(secondSummary!.newLinesSinceLastSummary).toBeLessThanOrEqual(secondSummary!.totalOutputLines);

    writeFileSync(join(workDir, 'summary-finish.signal'), 'finish', 'utf-8');
    mgr.kill(r.taskId);  // 清理
  }, 15_000);
});

describe('BackgroundTaskManager — formatRunningSummaryBlock', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-fmt-'));
    mgr = new BackgroundTaskManager(workDir, 'fmt-test');
  });

  afterEach(() => mgr.dispose());

  it('returns null when no running tasks', () => {
    expect(mgr.formatRunningSummaryBlock()).toBeNull();
  });

  it('formats running task as [Background Task Status] block', () => {
    mgr.spawn(sleepCmd(30), 60_000, 'fmt-test-cmd');
    const block = mgr.formatRunningSummaryBlock({ intervalMs: 1 });
    expect(block).not.toBeNull();
    expect(block!).toMatch(/^\[Background Task Status\]/);
    expect(block!).toMatch(/\[\/Background Task Status\]$/);
    expect(block!).toMatch(/fmt-test-cmd/);
    expect(block!).toMatch(/elapsed/);
    expect(block!).toMatch(/running/);
  });

  it('respects maxChars (truncates with `...more tasks` hint)', async () => {
    const longLabel = 'task-with-a-very-long-label-padding-'.repeat(3);
    for (let i = 0; i < 4; i++) {
      const spawned = mgr.spawn(sleepCmd(30), 60_000, `${longLabel}${i}`);
      expect(spawned.taskId, spawned.error).toBeTruthy();
    }

    await expect.poll(
      () => mgr.formatRunningSummaryBlock({ intervalMs: 1, maxChars: 120 }),
      { timeout: 10_000 },
    ).toMatch(/\.\.\. more tasks; use action:"list" to see all/);

    const block = mgr.formatRunningSummaryBlock({ intervalMs: 1, maxChars: 120 });
    expect(block!.length).toBeLessThanOrEqual(200);
  }, 15_000);

  it('after markSummaryEmitted, subsequent block is null until next interval', () => {
    mgr.spawn(sleepCmd(30), 60_000, 'one-shot');
    const first = mgr.formatRunningSummaryBlock({ intervalMs: 60_000 });
    expect(first).not.toBeNull();

    // 模拟「调用方刚发出摘要」
    const ids = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs: 60_000 }).map((s) => s.taskId);
    mgr.markSummaryEmitted(ids);

    const second = mgr.formatRunningSummaryBlock({ intervalMs: 60_000 });
    expect(second).toBeNull();  // throttled
  });
});

describe('BackgroundTaskManager — taskStatusChanged event', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-event-'));
    mgr = new BackgroundTaskManager(workDir, 'event-test');
  });

  afterEach(() => mgr.dispose());

  it('emits taskStatusChanged when task completes', async () => {
    writeFileSync(
      join(workDir, 'quick.cjs'),
      'console.log("done");\n',
      'utf-8',
    );
    const events: any[] = [];
    mgr.on('taskStatusChanged', (s) => events.push(s));

    const r = mgr.spawn('node quick.cjs', 10_000);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 12_000;
      const poll = () => {
        const match = events.find((e) => e.taskId === r.taskId && e.isTerminal);
        if (match) {
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error('taskStatusChanged terminal event not received in time'));
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });

    const match = events.find((e) => e.taskId === r.taskId && e.isTerminal);
    expect(match).toBeDefined();
    expect(match.isTerminal).toBe(true);
    expect(['completed', 'failed']).toContain(match.status);
  }, 15_000);

  it('emits taskStatusChanged when kill() is called', async () => {
    const events: any[] = [];
    mgr.on('taskStatusChanged', (s) => events.push(s));

    const r = mgr.spawn(sleepCmd(30), 60_000);
    await waitForTaskStatus(mgr, r.taskId, 'running');
    mgr.kill(r.taskId);

    expect(events.find((e) => e.taskId === r.taskId && e.status === 'killed')).toBeDefined();
  }, 10_000);
});
