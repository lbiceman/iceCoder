import { describe, expect, it } from 'vitest';

import {
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
