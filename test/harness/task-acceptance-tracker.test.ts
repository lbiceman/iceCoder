import { describe, expect, it } from 'vitest';

import {
  classifyRunCommandResult,
  hasPendingAcceptanceWork,
  normalizeAcceptanceCommandKey,
  parseAcceptanceCommandsFromGoal,
  stripLeadingCdPrefix,
  TaskAcceptanceTracker,
} from '../../src/harness/task-acceptance-tracker.js';
import { hasPendingWork } from '../../src/harness/incomplete-completion.js';

const BENCHMARK_GOAL = [
  'E:\\test\\implement-spellbrigade-survivor-second',
  '',
  '从零实现 survivors roguelike。',
  '只有 **`npm ci` → `npm test` → `npm run build` → `npm run test:e2e` 全部成功** 后，才输出交付 bullet 并结束',
].join('\n').padEnd(120, 'x');

describe('task-acceptance-tracker', () => {
  it('parses four-command acceptance chain from benchmark-style goal', () => {
    const cmds = parseAcceptanceCommandsFromGoal(BENCHMARK_GOAL);
    expect(cmds.map(c => c.label)).toEqual([
      'npm ci',
      'npm test',
      'npm run build',
      'npm run test:e2e',
    ]);
  });

  it('activates only for long-running implementation goals with 2+ commands', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    expect(tracker.isActive()).toBe(true);
    expect(tracker.isComplete()).toBe(false);
  });

  it('does not activate for short question goals', () => {
    const tracker = new TaskAcceptanceTracker('解释一下这个函数');
    expect(tracker.isActive()).toBe(false);
    expect(tracker.isComplete()).toBe(true);
  });

  it('requires all commands to pass before isComplete', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    tracker.recordRunCommand('npm test 2>&1', true);
    expect(tracker.isComplete()).toBe(false);
    expect(tracker.getPassedCount()).toBe(1);
    expect(hasPendingAcceptanceWork(tracker)).toBe(true);

    tracker.recordRunCommand('npm ci', true);
    tracker.recordRunCommand('npm run build 2>&1', true);
    tracker.recordRunCommand('npm run test:e2e', true);
    expect(tracker.isComplete()).toBe(true);
    expect(hasPendingAcceptanceWork(tracker)).toBe(false);
  });

  it('recordRunCommand returns transition with previous + new status', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const t1 = tracker.recordRunCommand('npm test', true);
    expect(t1).toEqual({ command: 'npm test', previousStatus: 'pending', newStatus: 'passed' });

    // 同条命令再跑一次 pass→pass
    const t2 = tracker.recordRunCommand('npm test', true);
    expect(t2).toEqual({ command: 'npm test', previousStatus: 'passed', newStatus: 'passed' });

    // 不匹配的命令
    const t3 = tracker.recordRunCommand('ls', true);
    expect(t3).toBeNull();
  });

  it('normalizeAcceptanceCommandKey strips noise', () => {
    expect(normalizeAcceptanceCommandKey('npm test 2>&1')).toBe('npm test');
    expect(normalizeAcceptanceCommandKey('npm run build 2>&1')).toBe('npm run build');
  });

  it('normalizeAcceptanceCommandKey strips leading cd && prefix (windows / posix)', () => {
    expect(normalizeAcceptanceCommandKey('cd /d E:\\foo && npm run build')).toBe('npm run build');
    expect(normalizeAcceptanceCommandKey('cd ./pkg && npm test')).toBe('npm test');
    expect(normalizeAcceptanceCommandKey('cd "C:\\Program Files\\app" && npm ci')).toBe('npm ci');
    // 单独 `cd somewhere` 不应被剥成空串
    expect(normalizeAcceptanceCommandKey('cd /tmp')).toBe('cd /tmp');
  });

  it('normalizeAcceptanceCommandKey normalizes playwright/cypress e2e to `npm run test:e2e`', () => {
    expect(normalizeAcceptanceCommandKey('npx playwright test --reporter=list')).toBe('npm run test:e2e');
    expect(normalizeAcceptanceCommandKey('cd /d E:\\app && npx playwright test')).toBe('npm run test:e2e');
    expect(normalizeAcceptanceCommandKey('npx cypress run')).toBe('npm run test:e2e');
  });

  it('normalizeAcceptanceCommandKey normalizes vitest / npm run test variants to `npm test`', () => {
    expect(normalizeAcceptanceCommandKey('npx vitest run --reporter=verbose')).toBe('npm test');
    expect(normalizeAcceptanceCommandKey('npx vitest')).toBe('npm test');
    expect(normalizeAcceptanceCommandKey('npm run test')).toBe('npm test');
    // test:e2e / test:unit 等带冒号的脚本应保留
    expect(normalizeAcceptanceCommandKey('npm run test:e2e')).toBe('npm run test:e2e');
  });

  it('normalizeAcceptanceCommandKey strips piped tail / head / redirects', () => {
    expect(normalizeAcceptanceCommandKey('npm test | tail -20')).toBe('npm test');
    expect(normalizeAcceptanceCommandKey('npm run build > out.log 2>&1')).toBe('npm run build');
  });

  it('stripLeadingCdPrefix returns body for cd && and original for plain cd', () => {
    expect(stripLeadingCdPrefix('cd /d E:\\x && npm test')).toBe('npm test');
    expect(stripLeadingCdPrefix('cd ./x && ls')).toBe('ls');
    expect(stripLeadingCdPrefix('cd /tmp')).toBe('cd /tmp');
    expect(stripLeadingCdPrefix('npm test')).toBe('npm test');
  });

  it('acceptance gate matches cd-prefixed run_command against bare goal entry', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const t = tracker.recordRunCommand(
      'cd /d E:\\test\\spell && npm run build 2>&1',
      true,
    );
    expect(t).not.toBeNull();
    expect(t?.command).toBe('npm run build');
    expect(t?.newStatus).toBe('passed');
  });

  it('acceptance gate matches `npx playwright test` against `npm run test:e2e`', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const t = tracker.recordRunCommand('npx playwright test --reporter=list 2>&1', true);
    expect(t).not.toBeNull();
    expect(t?.command).toBe('npm run test:e2e');
    expect(tracker.getPassedCount()).toBe(1);
  });

  it('snapshot restore roundtrip preserves progress', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    tracker.recordRunCommand('npm test', true);
    tracker.recordRunCommand('npm ci', true);
    const snap = tracker.snapshot();

    const restored = TaskAcceptanceTracker.fromSnapshot(snap);
    expect(restored.getPassedCount()).toBe(2);
    expect(restored.isComplete()).toBe(false);
  });

  it('classifyRunCommandResult: foreground success', () => {
    const r = classifyRunCommandResult(
      { command: 'npm ci' },
      'install ok\n',
      true,
    );
    expect(r).toEqual({ kind: 'foreground', command: 'npm ci', foregroundSuccess: true });
  });

  it('classifyRunCommandResult: foreground failure', () => {
    const r = classifyRunCommandResult(
      { command: 'npm test' },
      'Command failed (exit code: 1)',
      false,
    );
    expect(r).toEqual({ kind: 'foreground', command: 'npm test', foregroundSuccess: false });
  });

  it('classifyRunCommandResult: background start (mode:background)', () => {
    const out = JSON.stringify({ mode: 'background', taskId: 'bg_abc', status: 'started', label: 'npm test 2>&1' });
    const r = classifyRunCommandResult({ command: 'npm test 2>&1' }, out, true);
    expect(r).toEqual({ kind: 'background_start', command: 'npm test 2>&1' });
  });

  it('classifyRunCommandResult: background start (mode:escalated)', () => {
    const out = JSON.stringify({ mode: 'escalated', taskId: 'bg_xyz', reason: 'soft_timeout' });
    const r = classifyRunCommandResult({ command: 'npx vite build' }, out, true);
    expect(r?.kind).toBe('background_start');
  });

  it('classifyRunCommandResult: action:check running', () => {
    const out = JSON.stringify({ mode: 'check', taskId: 'bg_abc', label: 'npm test', status: 'running' });
    const r = classifyRunCommandResult({ action: 'check', task_id: 'bg_abc' }, out, true);
    expect(r).toEqual({ kind: 'background_running', command: 'npm test' });
  });

  it('classifyRunCommandResult: action:check completed exit 0', () => {
    const out = JSON.stringify({ mode: 'check', label: 'npm run build', status: 'completed', exitCode: 0 });
    const r = classifyRunCommandResult({ action: 'check', task_id: 'bg_a' }, out, true);
    expect(r).toEqual({ kind: 'background_completed', command: 'npm run build', exitCode: 0 });
  });

  it('classifyRunCommandResult: action:check completed exit non-zero → failed', () => {
    const out = JSON.stringify({ mode: 'check', label: 'npm test', status: 'completed', exitCode: 1 });
    const r = classifyRunCommandResult({ action: 'check', task_id: 'bg_a' }, out, true);
    expect(r?.kind).toBe('background_failed');
    expect(r && 'exitCode' in r ? r.exitCode : undefined).toBe(1);
  });

  it('classifyRunCommandResult: action:check status:failed', () => {
    const out = JSON.stringify({ mode: 'check', label: 'npm run test:e2e', status: 'failed' });
    const r = classifyRunCommandResult({ action: 'check', task_id: 'bg_a' }, out, false);
    expect(r?.kind).toBe('background_failed');
  });

  it('classifyRunCommandResult: returns null for non-JSON background output', () => {
    const r = classifyRunCommandResult({ action: 'check', task_id: 'bg_a' }, 'plain text', true);
    expect(r).toBeNull();
  });

  it('recordRunCommandToolResult: background_start keeps pending', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const transition = tracker.recordRunCommandToolResult({
      kind: 'background_start',
      command: 'npm test 2>&1',
    });
    expect(transition).toBeNull();
    expect(tracker.getPassedCount()).toBe(0);
  });

  it('recordRunCommandToolResult: background_completed exit 0 marks passed', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const transition = tracker.recordRunCommandToolResult({
      kind: 'background_completed',
      command: 'npm test',
      exitCode: 0,
    });
    expect(transition).not.toBeNull();
    expect(transition?.newStatus).toBe('passed');
    expect(transition?.previousStatus).toBe('pending');
    expect(tracker.getPassedCount()).toBe(1);
  });

  it('recordRunCommandToolResult: background_failed marks failed (not passed)', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const transition = tracker.recordRunCommandToolResult({
      kind: 'background_failed',
      command: 'npm run test:e2e',
      exitCode: 1,
      statusLabel: 'completed_nonzero',
    });
    expect(transition).not.toBeNull();
    expect(transition?.newStatus).toBe('failed');
    expect(tracker.hasFailure()).toBe(true);
    expect(tracker.getPassedCount()).toBe(0);
  });

  it('end-to-end: starting npm test in background does NOT prematurely pass it', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const startOut = JSON.stringify({ mode: 'background', taskId: 'bg_t', status: 'started', label: 'npm test 2>&1' });
    const startCls = classifyRunCommandResult({ command: 'npm test 2>&1' }, startOut, true);
    expect(startCls).toBeTruthy();
    tracker.recordRunCommandToolResult(startCls!);
    expect(tracker.getPassedCount()).toBe(0);

    // P0: 现在 check 响应应同时带 `command` 真实命令，让 acceptance 用 command 匹配而非 label。
    const checkOut = JSON.stringify({
      mode: 'check',
      label: 'npm test 2>&1',
      command: 'npm test 2>&1',
      status: 'completed',
      exitCode: 0,
    });
    const checkCls = classifyRunCommandResult({ action: 'check', task_id: 'bg_t' }, checkOut, true);
    tracker.recordRunCommandToolResult(checkCls!);
    expect(tracker.getPassedCount()).toBe(1);
  });

  it('classifyRunCommandResult: action:check prefers `command` over `label`', () => {
    // label 是用户传入的简单名 (`build-verify`)，命令是真实命令；acceptance gate 应认准命令
    const out = JSON.stringify({
      mode: 'check',
      label: 'build-verify',
      command: 'npm run build 2>&1',
      status: 'completed',
      exitCode: 0,
    });
    const r = classifyRunCommandResult({ action: 'check', task_id: 'bg_a' }, out, true);
    expect(r).toEqual({ kind: 'background_completed', command: 'npm run build 2>&1', exitCode: 0 });
  });

  it('classifyRunCommandResult: action:check falls back to label when command is missing (legacy)', () => {
    const out = JSON.stringify({ mode: 'check', label: 'npm test', status: 'completed', exitCode: 0 });
    const r = classifyRunCommandResult({ action: 'check', task_id: 'bg_a' }, out, true);
    expect(r).toEqual({ kind: 'background_completed', command: 'npm test', exitCode: 0 });
  });

  it('end-to-end: cd-prefixed background completion passes the acceptance entry via command', () => {
    // 模拟用户日志里出现的场景：模型用 cd /d ... && npm run build 启动后台任务，
    // check 时 shell-tool 现在会返回真实 command（含 cd 前缀），归一化后匹配 `npm run build`。
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const checkOut = JSON.stringify({
      mode: 'check',
      label: 'build-verify',
      command: 'cd /d E:\\test\\spell && npm run build 2>&1',
      status: 'completed',
      exitCode: 0,
    });
    const cls = classifyRunCommandResult({ action: 'check', task_id: 'bg_b' }, checkOut, true);
    const transition = tracker.recordRunCommandToolResult(cls!);
    expect(transition?.newStatus).toBe('passed');
    expect(transition?.command).toBe('npm run build');
  });

  it('hasPendingWork stays true when only npm test passed under acceptance gate', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    tracker.recordRunCommand('npm test 2>&1', true);
    expect(hasPendingWork(
      {
        goal: BENCHMARK_GOAL,
        intent: 'edit',
        phase: 'verification',
        filesRead: [],
        filesChanged: ['a.ts'],
        commandsRun: ['npm test 2>&1'],
        verificationRequired: true,
        verificationStatus: 'passed',
      },
      tracker,
    )).toBe(true);
  });
});
