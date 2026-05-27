import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackgroundTaskManager } from '../../src/tools/background-task-manager.js';

const isWindows = process.platform === 'win32';

function sleepCmd(seconds: number): string {
  return isWindows ? `ping -n ${seconds + 1} 127.0.0.1 > nul` : `sleep ${seconds}`;
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

    // 等到完成
    await new Promise((res) => setTimeout(res, 2_500));

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
    await new Promise((res) => setTimeout(res, 2_500));

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 1; i <= 5; i++) {
    console.log("slow line " + i);
    await sleep(500);
  }
})();
`,
      'utf-8',
    );
    const r = mgr.spawn('node slow.cjs', 30_000, 'slow');
    expect(r.taskId).toBeTruthy();

    // 第一次 check 在 ~1.2s 时（应当有 2-3 行）
    await new Promise((res) => setTimeout(res, 1_200));
    const first = mgr.getOutputSince(r.taskId, 0);
    const firstCursor = first!.cursor;
    expect(first!.output).toMatch(/slow line 1/);

    // 等到全部结束
    await new Promise((res) => setTimeout(res, 3_500));

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
    await new Promise((res) => setTimeout(res, 2_500));

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
    await new Promise((res) => setTimeout(res, 2_500));

    const expectedPath = join(workDir, 'data', 'sessions', 'log-test', 'bg', `${r.taskId}.log`);
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

      await new Promise((res) => setTimeout(res, 2_500));

      const p1 = join(workDir, 'data', 'sessions', 'sess-1', 'bg', `${r1.taskId}.log`);
      const p2 = join(workDir, 'data', 'sessions', 'sess-2', 'bg', `${r2.taskId}.log`);
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 1; i <= 10; i++) {
    console.log("burst " + i);
    await sleep(150);
  }
  await sleep(5000);  // keep running so getRunningSummary still sees it
})();
`,
      'utf-8',
    );
    const r = mgr.spawn('node output3.cjs', 30_000);
    await new Promise((res) => setTimeout(res, 800));  // some output

    const first = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs: 1 });
    const firstSummary = first.find((s) => s.taskId === r.taskId);
    expect(firstSummary).toBeDefined();
    const firstCount = firstSummary!.newLinesSinceLastSummary;
    expect(firstCount).toBeGreaterThan(0);

    mgr.markSummaryEmitted([r.taskId]);

    // 让更多输出累积
    await new Promise((res) => setTimeout(res, 1_500));

    const second = mgr.getRunningSummary({ onlyDirtyOrDue: true, intervalMs: 1 });
    const secondSummary = second.find((s) => s.taskId === r.taskId);
    expect(secondSummary).toBeDefined();
    expect(secondSummary!.newLinesSinceLastSummary).toBeGreaterThan(0);
    // emit 后 lastEmittedTotalCache 重置；第二次只算 emit 之后的新增
    expect(secondSummary!.newLinesSinceLastSummary).toBeLessThanOrEqual(secondSummary!.totalOutputLines);

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

  it('respects maxChars (truncates with `...more tasks` hint)', () => {
    // 起 10 个 sleeper（其中 8 个能成功，8 是 MAX_CONCURRENT）
    for (let i = 0; i < 8; i++) {
      mgr.spawn(sleepCmd(30), 60_000, `task-with-a-longer-label-${i}`);
    }
    const block = mgr.formatRunningSummaryBlock({ intervalMs: 1, maxChars: 200 });
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(300);  // 包括 truncation hint
    expect(block!).toMatch(/more tasks/);
  });

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
    await new Promise((res) => setTimeout(res, 2_500));

    expect(events.length).toBeGreaterThanOrEqual(1);
    const match = events.find((e) => e.taskId === r.taskId);
    expect(match).toBeDefined();
    expect(match.isTerminal).toBe(true);
    expect(['completed', 'failed']).toContain(match.status);
  }, 15_000);

  it('emits taskStatusChanged when kill() is called', async () => {
    const events: any[] = [];
    mgr.on('taskStatusChanged', (s) => events.push(s));

    const r = mgr.spawn(sleepCmd(30), 60_000);
    await new Promise((res) => setTimeout(res, 500));
    mgr.kill(r.taskId);

    expect(events.find((e) => e.taskId === r.taskId && e.status === 'killed')).toBeDefined();
  }, 10_000);
});
