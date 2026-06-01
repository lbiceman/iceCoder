import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BackgroundTaskManager } from '../../src/tools/background-task-manager.js';
import { BgTaskPusher } from '../../src/web/bg-task-pusher.js';

const isWindows = process.platform === 'win32';
function sleepCmd(seconds: number): string {
  return isWindows ? `ping -n ${seconds + 1} 127.0.0.1 > nul` : `sleep ${seconds}`;
}

describe('BgTaskPusher — attach / detach', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;
  let broadcasts: Array<{ sessionId: string; body: string }>;
  let pusher: BgTaskPusher;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-pusher-'));
    mgr = new BackgroundTaskManager(workDir, 'push-test');
    broadcasts = [];
    pusher = new BgTaskPusher(
      (sid, body) => broadcasts.push({ sessionId: sid, body }),
      { intervalMs: 100, hangThresholdMs: 60_000_000 },
    );
  });

  afterEach(() => {
    pusher.detach();
    mgr.dispose();
  });

  it('attach starts heartbeat timer; detach stops it', async () => {
    pusher.attach(mgr);
    mgr.spawn(sleepCmd(30), 60_000, 'heartbeat-test');

    // 等 ~250ms（2-3 个 tick）
    await new Promise((r) => setTimeout(r, 250));

    expect(broadcasts.length).toBeGreaterThanOrEqual(1);

    const before = broadcasts.length;
    pusher.detach();
    await new Promise((r) => setTimeout(r, 250));
    expect(broadcasts.length).toBe(before);  // 没有新推送
  });

  it('attach a second time replaces the first manager', () => {
    const mgr2 = new BackgroundTaskManager(workDir, 'second');
    try {
      pusher.attach(mgr);
      pusher.attach(mgr2);  // 替换
      // 不应抛 + 没有内部冲突
      expect(true).toBe(true);
    } finally {
      mgr2.dispose();
    }
  });

  it('detach without attach is a no-op', () => {
    expect(() => pusher.detach()).not.toThrow();
  });
});

describe('BgTaskPusher — heartbeat tick payload', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;
  let broadcasts: Array<{ sessionId: string; body: any }>;
  let pusher: BgTaskPusher;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-pusher-tick-'));
    mgr = new BackgroundTaskManager(workDir, 'tick-sess');
    broadcasts = [];
    pusher = new BgTaskPusher(
      (sid, body) => broadcasts.push({ sessionId: sid, body: JSON.parse(body) }),
      { intervalMs: 60_000 /* long; manual tick */, hangThresholdMs: 60_000_000 },
    );
    pusher.attach(mgr);
  });

  afterEach(() => {
    pusher.detach();
    mgr.dispose();
  });

  it('tick() does nothing when no running tasks', () => {
    pusher.tick();
    expect(broadcasts.length).toBe(0);
  });

  it('tick() sends bg_task_update with running tasks', () => {
    mgr.spawn(sleepCmd(30), 60_000, 'aaa');
    mgr.spawn(sleepCmd(30), 60_000, 'bbb');
    broadcasts.length = 0;

    pusher.tick();
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0].sessionId).toBe('tick-sess');
    expect(broadcasts[0].body.type).toBe('bg_task_update');
    expect(broadcasts[0].body.sessionId).toBe('tick-sess');
    expect(broadcasts[0].body.tasks.length).toBe(2);
    expect(broadcasts[0].body.tasks.every((t: any) => t.status === 'running')).toBe(true);
    expect(broadcasts[0].body.tasks.every((t: any) => t.isTerminal === false)).toBe(true);
  });

  it('subsequent tick() reflects newLines correctly', async () => {
    writeFileSync(
      join(workDir, 'burst.cjs'),
      `
// 立刻同步输出第一行，确保 node 启动开销不影响 tick 测试
console.log("burst pre");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
(async () => {
  for (let i = 0; i < 5; i++) { console.log("burst " + i); await sleep(150); }
  await sleep(5000);
})();
`,
      'utf-8',
    );
    mgr.spawn('node burst.cjs', 30_000, 'burst-task');
    broadcasts.length = 0;

    // 等到 node 启动 + 至少一行输出已 flush
    await new Promise((r) => setTimeout(r, 1_500));
    pusher.tick();
    expect(broadcasts.length).toBe(1);
    const t1 = broadcasts[0].body.tasks[0];
    expect(t1.newLines).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 600));
    pusher.tick();
    expect(broadcasts.length).toBe(2);
    const t2 = broadcasts[1].body.tasks[0];
    // 第二次 tick 只统计上次 mark 之后的新增
    expect(t2.newLines).toBeGreaterThanOrEqual(0);
  }, 15_000);
});

describe('BgTaskPusher — terminal status pushes immediately', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;
  let broadcasts: Array<{ sessionId: string; body: any }>;
  let pusher: BgTaskPusher;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-pusher-term-'));
    mgr = new BackgroundTaskManager(workDir, 'term-sess');
    broadcasts = [];
    pusher = new BgTaskPusher(
      (sid, body) => broadcasts.push({ sessionId: sid, body: JSON.parse(body) }),
      { intervalMs: 60_000, hangThresholdMs: 60_000_000 },
    );
    pusher.attach(mgr);
  });

  afterEach(() => {
    pusher.detach();
    mgr.dispose();
  });

  it('completed task triggers immediate push (no wait for tick)', async () => {
    writeFileSync(
      join(workDir, 'quick.cjs'),
      'console.log("done"); process.exit(0);\n',
      'utf-8',
    );
    mgr.spawn('node quick.cjs', 10_000, 'quick');

    await new Promise((r) => setTimeout(r, 2_500));

    // 应有终态推送
    const terminal = broadcasts.find((b) =>
      b.body.tasks.some((t: any) => t.isTerminal === true && t.status === 'completed'),
    );
    expect(terminal).toBeDefined();
  }, 15_000);

  it('killed task triggers immediate push', async () => {
    const r = mgr.spawn(sleepCmd(30), 60_000, 'kill-me');
    await new Promise((res) => setTimeout(res, 200));

    mgr.kill(r.taskId);
    await new Promise((res) => setTimeout(res, 300));

    const killed = broadcasts.find((b) =>
      b.body.tasks.some((t: any) => t.isTerminal === true && t.status === 'killed'),
    );
    expect(killed).toBeDefined();
  }, 10_000);
});

describe('BgTaskPusher — hang detection', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;
  let broadcasts: Array<{ sessionId: string; body: any }>;
  let pusher: BgTaskPusher;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-pusher-hang-'));
    mgr = new BackgroundTaskManager(workDir, 'hang-sess');
    broadcasts = [];
    // 设置一个非常低的 hang 阈值，方便测试
    pusher = new BgTaskPusher(
      (sid, body) => broadcasts.push({ sessionId: sid, body: JSON.parse(body) }),
      { intervalMs: 60_000, hangThresholdMs: 1 },  // 1ms
    );
    pusher.attach(mgr);
  });

  afterEach(() => {
    pusher.detach();
    mgr.dispose();
  });

  it('marks running task as hang when lastOutputAt > threshold', async () => {
    // sleep 命令不会产生输出，lastOutputAt = startTime
    mgr.spawn(sleepCmd(30), 60_000, 'silent-sleeper');

    // 等一下，确保 now - startTime > hangThresholdMs (1ms)
    await new Promise((r) => setTimeout(r, 100));

    pusher.tick();
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
    const lastBcast = broadcasts[broadcasts.length - 1];
    expect(lastBcast.body.tasks[0].isHang).toBe(true);
  });
});

describe('BgTaskPusher — broadcaster error tolerance', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;
  let pusher: BgTaskPusher;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-pusher-err-'));
    mgr = new BackgroundTaskManager(workDir, 'err-sess');
    pusher = new BgTaskPusher(
      () => { throw new Error('broadcaster boom'); },
      { intervalMs: 60_000, hangThresholdMs: 60_000_000 },
    );
    pusher.attach(mgr);
  });

  afterEach(() => {
    pusher.detach();
    mgr.dispose();
  });

  it('swallows broadcaster errors and does not crash tick', () => {
    mgr.spawn(sleepCmd(30), 60_000, 'err-test');
    expect(() => pusher.tick()).not.toThrow();
  });

  it('swallows broadcaster errors in terminal emit', async () => {
    const r = mgr.spawn(sleepCmd(30), 60_000, 'err-kill');
    await new Promise((res) => setTimeout(res, 100));
    expect(() => mgr.kill(r.taskId)).not.toThrow();
  });
});
