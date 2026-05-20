import { describe, expect, it } from 'vitest';

import {
  buildModeDecisionContext,
  buildRuntimeExecutionState,
} from '../../src/harness/supervisor/runtime-execution-state.js';
import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';

const cfg = defaultSupervisorConfig().executionMode!;

describe('RuntimeExecutionState - Batch 2', () => {
  it('builds readonly tool plans as L0-ready runtime input', () => {
    const state = buildRuntimeExecutionState({
      round: 3,
      readonlyToolNames: cfg.readonlyToolNames,
      plannedToolNames: ['read_file', 'search'],
    });

    expect(state).toMatchObject({
      round: 3,
      taskGraphActive: false,
      pendingStepCount: 0,
      plannedWriteTargets: 0,
      writeTargetsThisRound: 0,
      activeGraphHasImplementNode: false,
      plannedToolNames: ['read_file', 'search'],
    });
  });

  it('maps readonly graph state into taskGraphActive, pendingStepCount, and implement-node flags', () => {
    const state = buildRuntimeExecutionState({
      round: 4,
      readonlyToolNames: cfg.readonlyToolNames,
      plannedToolNames: ['edit_file'],
      graphState: {
        active: true,
        pendingStepCount: 2,
        activeGraphHasImplementNode: true,
      },
    });

    expect(state.taskGraphActive).toBe(true);
    expect(state.pendingStepCount).toBe(2);
    expect(state.activeGraphHasImplementNode).toBe(true);
    expect(state.plannedWriteTargets).toBe(1);
  });

  it('maps checkpoint resume into state without writing executionMode', () => {
    const runtimeState = buildRuntimeExecutionState({
      round: 5,
      readonlyToolNames: cfg.readonlyToolNames,
      checkpointResumedThisSession: true,
    });
    const context = buildModeDecisionContext({
      round: 5,
      executionMode: 'free',
      executionModeLockRemaining: 0,
      supervisorMode: 'adaptive',
      supervisorPhase: 'free',
      riskLevel: 'L2_structural',
      state: runtimeState,
      signals: ['checkpoint_resumed'],
    });

    expect(runtimeState.checkpointResumedThisSession).toBe(true);
    expect('executionMode' in runtimeState).toBe(false);
    expect(context.executionMode).toBe('free');
    expect(context.signals).toEqual(['checkpoint_resumed']);
  });
});
