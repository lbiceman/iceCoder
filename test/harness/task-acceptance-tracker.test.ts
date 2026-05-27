import { describe, expect, it } from 'vitest';

import {
  classifyRunCommandResult,
  hasPendingAcceptanceWork,
  normalizeAcceptanceCommandKey,
  parseAcceptanceCommandsFromGoal,
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

  it('normalizeAcceptanceCommandKey strips noise', () => {
    expect(normalizeAcceptanceCommandKey('npm test 2>&1')).toBe('npm test');
    expect(normalizeAcceptanceCommandKey('npm run build 2>&1')).toBe('npm run build');
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
    const changed = tracker.recordRunCommandToolResult({
      kind: 'background_start',
      command: 'npm test 2>&1',
    });
    expect(changed).toBe(false);
    expect(tracker.getPassedCount()).toBe(0);
  });

  it('recordRunCommandToolResult: background_completed exit 0 marks passed', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const changed = tracker.recordRunCommandToolResult({
      kind: 'background_completed',
      command: 'npm test',
      exitCode: 0,
    });
    expect(changed).toBe(true);
    expect(tracker.getPassedCount()).toBe(1);
  });

  it('recordRunCommandToolResult: background_failed marks failed (not passed)', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const changed = tracker.recordRunCommandToolResult({
      kind: 'background_failed',
      command: 'npm run test:e2e',
      exitCode: 1,
      statusLabel: 'completed_nonzero',
    });
    expect(changed).toBe(true);
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

    const checkOut = JSON.stringify({ mode: 'check', label: 'npm test 2>&1', status: 'completed', exitCode: 0 });
    const checkCls = classifyRunCommandResult({ action: 'check', task_id: 'bg_t' }, checkOut, true);
    tracker.recordRunCommandToolResult(checkCls!);
    expect(tracker.getPassedCount()).toBe(1);
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
      {
        filesRead: [],
        filesChanged: ['a.ts'],
        commandsRun: ['npm test 2>&1'],
        testCommands: ['npm test 2>&1'],
        recentDiagnostics: [],
      },
      tracker,
    )).toBe(true);
  });
});
