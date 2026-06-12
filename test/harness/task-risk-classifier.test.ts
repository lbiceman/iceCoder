import { describe, expect, it } from 'vitest';

import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import { TaskRiskClassifier } from '../../src/harness/supervisor/task-risk-classifier.js';
import type { RuntimeExecutionState } from '../../src/types/supervisor.js';

const cfg = defaultSupervisorConfig().executionMode!;

function state(overrides: Partial<RuntimeExecutionState> = {}): RuntimeExecutionState {
  return {
    round: 1,
    taskGraphActive: false,
    pendingStepCount: 0,
    writeTargetsThisRound: 0,
    plannedWriteTargets: 0,
    accumulatedDiffLines: 0,
    branchSwitchedThisRound: false,
    checkpointResumedThisSession: false,
    lastToolSuccess: true,
    recoveryPending: false,
    branchDebt: 0,
    stableRounds: 0,
    activeGraphHasImplementNode: false,
    readonlyToolNames: cfg.readonlyToolNames,
    plannedToolNames: ['read_file', 'glob'],
    forcedEntryRound: null,
    forcedTaskBearingRoundsSinceEntry: 0,
    ...overrides,
  };
}

describe('TaskRiskClassifier - Batch 2', () => {
  it('classifies readonly plans with no graph or writes as L0 observation', () => {
    const classifier = new TaskRiskClassifier(cfg);

    expect(classifier.classify(state())).toBe('L0_observation');
  });

  it('classifies a single small write as L1 minor edit', () => {
    const classifier = new TaskRiskClassifier(cfg);

    expect(classifier.classify(state({
      plannedToolNames: ['edit_file'],
      plannedWriteTargets: 1,
      writeTargetsThisRound: 1,
      accumulatedDiffLines: cfg.diffLinesEnterThreshold,
    }))).toBe('L1_minor_edit');
  });

  it('classifies any runtime forced-entry condition as L2 structural', () => {
    const classifier = new TaskRiskClassifier(cfg);

    expect(classifier.classify(state({ taskGraphActive: true }))).toBe('L2_structural');
    expect(classifier.classify(state({ pendingStepCount: cfg.pendingStepsEnterThreshold }))).toBe('L2_structural');
    expect(classifier.classify(state({ plannedWriteTargets: cfg.writeTargetsEnterThreshold + 1 }))).toBe('L2_structural');
    expect(classifier.classify(state({ branchSwitchedThisRound: true }))).toBe('L2_structural');
    expect(classifier.classify(state({ checkpointResumedThisSession: true }))).toBe('L2_structural');
    expect(classifier.classify(state({ lastToolSuccess: false }))).toBe('L2_structural');
    expect(classifier.classify(state({ accumulatedDiffLines: cfg.diffLinesEnterThreshold + 1 }))).toBe('L2_structural');
    expect(classifier.classify(state({ activeGraphHasImplementNode: true }))).toBe('L2_structural');
  });

  it('does not depend on user goal keywords or task intent text', () => {
    const classifier = new TaskRiskClassifier(cfg);
    const observation = state({
      plannedToolNames: ['read_file'],
      plannedWriteTargets: 0,
      writeTargetsThisRound: 0,
    });

    expect(classifier.classify(observation)).toBe('L0_observation');
  });
});
