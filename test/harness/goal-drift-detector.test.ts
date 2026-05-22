import { describe, expect, it } from 'vitest';

import { GoalDriftDetector } from '../../src/harness/supervisor/goal-drift-detector.js';
import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import type { TaskContext } from '../../src/types/supervisor.js';

const config = defaultSupervisorConfig();
const triggers = config.triggers;
const goalDrift = config.goalDrift;

function makeTask(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    goal: 'fix the broken login flow',
    intent: 'debug',
    domain: 'critical_debug',
    filesChanged: ['src/auth.ts'],
    filesRead: [],
    commandsRun: [],
    recentFailureCount: 0,
    branchBudgetTriggers: 0,
    ...overrides,
  };
}

describe('GoalDriftDetector - toggle / enablement', () => {
  it('returns alignment=1 and no signal when goalDriftEnabled=false', () => {
    const detector = new GoalDriftDetector(goalDrift, { ...triggers, goalDriftEnabled: false });
    const result = detector.evaluate({
      task: makeTask({ intent: 'edit', filesChanged: [] }),
      toolNames: ['read_file', 'read_file', 'read_file'],
      toolSuccess: [true, true, true],
      hadWriteTool: false,
    });
    expect(result.alignment).toBe(1);
    expect(result.signal).toBeUndefined();
    expect(detector.isEnabled()).toBe(false);
  });
});

describe('GoalDriftDetector - heuristic factors', () => {
  it('penalizes editing intent when only read-only tools are used and no files changed', () => {
    const detector = new GoalDriftDetector(goalDrift, triggers);
    const result = detector.evaluate({
      task: makeTask({ intent: 'edit', filesChanged: [] }),
      toolNames: ['read_file', 'read_file', 'read_file'],
      toolSuccess: [true, true, true],
      hadWriteTool: false,
    });
    expect(result.alignment).toBeLessThan(goalDrift.alignmentThreshold);
    expect(result.factors.toolIntent).toBeLessThan(0.5);
  });

  it('rewards editing intent when write tools and filesChanged are present', () => {
    const detector = new GoalDriftDetector(goalDrift, triggers);
    const result = detector.evaluate({
      task: makeTask({ intent: 'edit', filesChanged: ['src/a.ts'] }),
      toolNames: ['edit_file'],
      toolSuccess: [true],
      hadWriteTool: true,
      lastAssistantText: 'Editing src/a.ts to fix the broken login flow',
    });
    expect(result.alignment).toBeGreaterThan(goalDrift.alignmentThreshold);
  });

  it('rewards inspect intent for read-heavy tool plans', () => {
    const detector = new GoalDriftDetector(goalDrift, triggers);
    const result = detector.evaluate({
      task: makeTask({ intent: 'inspect', filesChanged: [], filesRead: ['README.md'] }),
      toolNames: ['read_file', 'grep'],
      toolSuccess: [true, true],
      hadWriteTool: false,
    });
    expect(result.factors.toolIntent).toBeGreaterThan(0.6);
  });

  it('progress factor decays when recent failures and branch triggers stack up', () => {
    const detector = new GoalDriftDetector(goalDrift, triggers);
    const result = detector.evaluate({
      task: makeTask({ recentFailureCount: 4, branchBudgetTriggers: 3 }),
      toolNames: ['run_command'],
      toolSuccess: [false],
      hadWriteTool: false,
    });
    expect(result.factors.progress).toBeLessThan(0.5);
  });
});

describe('GoalDriftDetector - consecutive streak', () => {
  it('emits goal_drift signal only after consecutiveRoundsBelow consecutive low scores', () => {
    const detector = new GoalDriftDetector(goalDrift, triggers);
    const badInput = {
      task: makeTask({ intent: 'edit' as const, filesChanged: [] as string[] }),
      toolNames: ['read_file', 'read_file'],
      toolSuccess: [true, true],
      hadWriteTool: false,
    };

    const first = detector.evaluate(badInput);
    expect(first.belowThresholdRoundsConsecutive).toBe(1);
    expect(first.signal).toBeUndefined();

    const second = detector.evaluate(badInput);
    expect(second.belowThresholdRoundsConsecutive).toBe(2);
    expect(second.signal).toEqual({ type: 'goal_drift', alignment: second.alignment });
  });

  it('resets streak when alignment recovers above threshold', () => {
    const detector = new GoalDriftDetector(goalDrift, triggers);
    detector.evaluate({
      task: makeTask({ intent: 'edit', filesChanged: [] }),
      toolNames: ['read_file'],
      toolSuccess: [true],
      hadWriteTool: false,
    });
    expect(detector.getRecentHistory().length).toBe(1);

    detector.evaluate({
      task: makeTask({ intent: 'edit', filesChanged: ['src/a.ts'] }),
      toolNames: ['edit_file'],
      toolSuccess: [true],
      hadWriteTool: true,
      lastAssistantText: 'fix the broken login flow by editing src/auth.ts',
    });

    const third = detector.evaluate({
      task: makeTask({ intent: 'edit', filesChanged: [] }),
      toolNames: ['read_file'],
      toolSuccess: [true],
      hadWriteTool: false,
    });
    expect(third.belowThresholdRoundsConsecutive).toBe(1);
    expect(third.signal).toBeUndefined();
  });

  it('reset clears streak and history', () => {
    const detector = new GoalDriftDetector(goalDrift, triggers);
    detector.evaluate({
      task: makeTask({ intent: 'edit', filesChanged: [] }),
      toolNames: ['read_file'],
      toolSuccess: [true],
      hadWriteTool: false,
    });
    detector.evaluate({
      task: makeTask({ intent: 'edit', filesChanged: [] }),
      toolNames: ['read_file'],
      toolSuccess: [true],
      hadWriteTool: false,
    });
    detector.reset();
    expect(detector.getRecentHistory()).toEqual([]);

    const next = detector.evaluate({
      task: makeTask({ intent: 'edit', filesChanged: [] }),
      toolNames: ['read_file'],
      toolSuccess: [true],
      hadWriteTool: false,
    });
    expect(next.belowThresholdRoundsConsecutive).toBe(1);
    expect(next.signal).toBeUndefined();
  });
});
