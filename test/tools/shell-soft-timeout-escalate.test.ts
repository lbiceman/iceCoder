import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { createShellTool } from '../../src/tools/builtin/shell-tool.js';
import { BackgroundTaskManager } from '../../src/tools/background-task-manager.js';

const isWindows = process.platform === 'win32';

/** 跨平台 sleep（秒）命令 — 在 cmd.exe / sh 里都能跑。 */
function sleepCmd(seconds: number): string {
  if (isWindows) {
    // ping with localhost timeouts; -n N waits N-1 seconds approx
    return `ping -n ${seconds + 1} 127.0.0.1 > nul`;
  }
  return `sleep ${seconds}`;
}

describe('BackgroundTaskManager.adopt() — unit', () => {
  let workDir: string;
  let mgr: BackgroundTaskManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-adopt-'));
    mgr = new BackgroundTaskManager(workDir);
  });

  afterEach(() => {
    mgr.dispose();
  });

  it('adopts a running child and returns taskId', async () => {
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const args = isWindows ? ['/c', sleepCmd(2)] : ['-c', sleepCmd(2)];
    const child = spawn(shell, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });

    const result = mgr.adopt(child, {
      command: 'sleep 2',
      label: 'sleep test',
      prefixOutput: 'prior line 1\nprior line 2',
      hardTimeoutMs: 60_000,
      reason: 'soft_timeout',
    });

    expect(result.taskId).toMatch(/^bg_/);
    expect(result.error).toBeUndefined();

    const status = mgr.getStatus(result.taskId);
    expect(status?.status).toBe('running');
    expect(status?.label).toBe('sleep test');

    // prefix output present in buffer
    const out = mgr.getOutput(result.taskId, 100);
    expect(out).toMatch(/prior line/);

    // wait for natural completion
    await new Promise((r) => setTimeout(r, 4_000));

    const finalStatus = mgr.getStatus(result.taskId);
    expect(['completed', 'failed']).toContain(finalStatus?.status);
  }, 15_000);

  it('refuses adopt when MAX_CONCURRENT reached', () => {
    // Fill up with 8 running adopts of `sleep 30`
    const children = [];
    for (let i = 0; i < 8; i++) {
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const args = isWindows ? ['/c', sleepCmd(30)] : ['-c', sleepCmd(30)];
      const c = spawn(shell, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(c);
      const r = mgr.adopt(c, { command: 'sleep 30', hardTimeoutMs: 60_000 });
      expect(r.error).toBeUndefined();
    }

    // 9th must fail
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const args = isWindows ? ['/c', sleepCmd(30)] : ['-c', sleepCmd(30)];
    const extra = spawn(shell, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
    const r = mgr.adopt(extra, { command: 'sleep 30', hardTimeoutMs: 60_000 });
    expect(r.taskId).toBe('');
    expect(r.error).toMatch(/上限/);

    // Cleanup
    for (const c of children) try { c.kill(); } catch { /* ignore */ }
    try { extra.kill(); } catch { /* ignore */ }
  }, 20_000);

  it('hard timeout in adopt kills the child eventually', async () => {
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const args = isWindows ? ['/c', sleepCmd(10)] : ['-c', sleepCmd(10)];
    const child = spawn(shell, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });

    const result = mgr.adopt(child, {
      command: 'sleep 10',
      hardTimeoutMs: 1_000,  // 1s
      reason: 'soft_timeout',
    });
    expect(result.taskId).toBeTruthy();

    // wait > hard timeout + kill grace
    await new Promise((r) => setTimeout(r, 4_500));

    const status = mgr.getStatus(result.taskId);
    expect(status?.status === 'timeout' || status?.status === 'failed').toBe(true);
  }, 10_000);
});

describe('shell-tool — soft timeout escalate (e2e)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ice-escalate-'));
  });

  /**
   * 用 `sleep 12` 验证软超时 escalate：
   * - 不是 long 也不是 short → 'auto'
   * - 8s 内不结束 → 应当 escalate 到后台
   *
   * sleep 12 不在 SHORT_FAST 白名单里，会走 auto 分支。
   * 但 args.timeout 默认 30s，确保 hard timeout 不先于 soft timeout 触发。
   */
  it('escalates a 12s sleep to background after ~8s', async () => {
    const tool = createShellTool(workDir);

    const start = Date.now();
    const result = await tool.handler({ command: sleepCmd(12) });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    // escalate 应在 ~8s 时触发（允许 ±2s 波动）
    expect(elapsed).toBeGreaterThan(7_000);
    expect(elapsed).toBeLessThan(11_000);

    const parsed = JSON.parse(result.output);
    expect(parsed.mode).toBe('escalated');
    expect(parsed.taskId).toMatch(/^bg_/);
    expect(parsed.reason).toBe('soft_timeout');
    expect(parsed.hint).toMatch(/check/i);
  }, 20_000);

  it('does NOT escalate a short command (< 8s)', async () => {
    const tool = createShellTool(workDir);

    const start = Date.now();
    const result = await tool.handler({ command: sleepCmd(2) });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(7_000);
    // not escalated → no 'mode':'escalated' wrapper
    expect(result.output).not.toMatch(/"mode":\s*"escalated"/);
  }, 15_000);

  it('does NOT escalate when background:false is explicit (forces sync wait)', async () => {
    const tool = createShellTool(workDir);

    const start = Date.now();
    const result = await tool.handler({
      command: sleepCmd(3),
      background: false,
      timeout: 10_000,
    });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(elapsed).toBeGreaterThan(2_500);
    expect(result.output).not.toMatch(/"mode":\s*"escalated"/);
  }, 15_000);

  it('escalated task still polls via action:"check"', async () => {
    const tool = createShellTool(workDir);

    const startResult = await tool.handler({ command: sleepCmd(12) });
    const startParsed = JSON.parse(startResult.output);
    expect(startParsed.mode).toBe('escalated');

    // check immediately
    const checkResult = await tool.handler({ action: 'check', task_id: startParsed.taskId });
    expect(checkResult.output).toMatch(/running|completed/);

    // wait until finished
    await new Promise((r) => setTimeout(r, 7_000));

    const finalCheck = await tool.handler({ action: 'check', task_id: startParsed.taskId });
    expect(finalCheck.output).toMatch(/completed|failed/);
  }, 30_000);
});
