import { describe, expect, it } from 'vitest';

import {
  hasPendingAcceptanceWork,
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

  it('does not treat file paths, formulas, or quoted phrases as acceptance commands', () => {
    const goal = [
      '禁止修改 `test/`、`package.json`、`vitest.config.ts`、`scripts/generate-fixtures.mjs`。',
      '必须先阅读 `README.md` 和 `docs/DOMAIN-MODEL.md`。',
      '以 `"source of truth"` 为准；`available = onHand - reserved - safetyStock`；隔离用 `tenantId`。',
      '只有 `npm ci`、`npm test`、`npm run test:integration`、`npm run test:contracts`、`npm run migrate:check`、`npm run audit:snapshot`、`npm run build` 全部 exit 0 后结束。',
    ].join('\n');
    expect(parseAcceptanceCommandsFromGoal(goal).map(c => c.label)).toEqual([
      'npm ci',
      'npm test',
      'npm run test:integration',
      'npm run test:contracts',
      'npm run migrate:check',
      'npm run audit:snapshot',
      'npm run build',
    ]);
  });

  it('marks every segment of a successful && chain, and ignores unrelated git diff failures', () => {
    const tracker = new TaskAcceptanceTracker([
      '从零实现仓库。',
      '只有 `npm test`、`npm run test:integration`、`npm run build` 全部成功后结束。',
    ].join('\n').padEnd(120, 'x'));
    expect(tracker.isActive()).toBe(true);

    tracker.recordRunCommand('npm run test:integration', false);
    expect(tracker.hasFailure()).toBe(true);

    const git = tracker.recordRunCommand(
      'cd /d E:\\repo && git diff --name-only -- test/ package.json vitest.config.ts',
      false,
    );
    expect(git).toBeNull();

    const chained = tracker.recordRunCommand(
      'cd /d E:\\repo && npm test && npm run test:integration && npm run build 2>&1',
      true,
    );
    expect(chained?.newStatus).toBe('passed');
    expect(tracker.isComplete()).toBe(true);
    expect(tracker.hasFailure()).toBe(false);
  });


  it('registers opaque user commands from backticks', () => {
    expect(parseAcceptanceCommandsFromGoal('必须跑 `./scripts/ci.sh`').map(c => c.label))
      .toEqual(['./scripts/ci.sh']);
    expect(parseAcceptanceCommandsFromGoal('验收：`cargo test`').map(c => c.label))
      .toEqual(['cargo test']);
    expect(parseAcceptanceCommandsFromGoal('run `npx vitest run` then stop').map(c => c.label))
      .toEqual(['npx vitest run']);
  });

  it('does not activate for short question goals', () => {
    const tracker = new TaskAcceptanceTracker('解释一下这个函数');
    expect(tracker.isActive()).toBe(false);
    expect(tracker.isComplete()).toBe(true);
  });

  it('activates for one explicitly required command in any toolchain', () => {
    const tracker = new TaskAcceptanceTracker(
      '完成条件：必须通过 `cargo test --workspace` 后才能结束。',
    );
    expect(tracker.isActive()).toBe(true);
    expect(tracker.getPendingCommands().map(item => item.label)).toEqual([
      'cargo test --workspace',
    ]);
    tracker.recordRunCommand('cargo test --workspace', true);
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

  it('exports tracked progress as evidence-backed completion conditions', () => {
    const tracker = new TaskAcceptanceTracker(
      '完成条件：必须运行 `make verify` 后才能结束。',
    );
    tracker.recordRunCommand('C:\\tools\\make.exe verify', true, 'tool-1');

    expect(tracker.toCompletionConditions()).toEqual([
      expect.objectContaining({
        required: true,
        status: 'satisfied',
        evidenceRefs: ['tool-1'],
      }),
    ]);
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

  it('does not alias npx playwright test to npm run test:e2e', () => {
    const tracker = new TaskAcceptanceTracker(BENCHMARK_GOAL);
    const t = tracker.recordRunCommand('npx playwright test --reporter=list 2>&1', true);
    expect(t).toBeNull();
    expect(tracker.getPassedCount()).toBe(0);
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
      },
      tracker,
    )).toBe(true);
  });
});
