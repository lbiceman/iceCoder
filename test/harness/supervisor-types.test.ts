import { describe, expect, it } from 'vitest';

import {
  MODE_SIGNAL_PRECEDENCE,
  type ExecutionModeTelemetryPayload,
  type RuntimeExecutionState,
  type SupervisorConfigFile,
} from '../../src/types/supervisor.js';
import {
  emptyRuntimeCheckpointV2,
  isRuntimeCheckpointV2,
  type RuntimeCheckpointV2,
} from '../../src/types/runtime-checkpoint.js';

describe('supervisor types - Batch 1', () => {
  it('exposes frozen V1.3.6 signal precedence for later decision code', () => {
    expect(MODE_SIGNAL_PRECEDENCE).toEqual([
      'checkpoint_resumed',
      'task_graph_active',
      'branch_switched',
      'pending_steps',
      'tool_failure',
      'multi_write',
      'large_diff',
      'explicit_impl',
    ]);
  });

  it('keeps runtime checkpoint v2 backward compatible when supervisor state is absent', () => {
    const oldRuntimeV2: RuntimeCheckpointV2 = {
      runtimeVersion: 2,
      branchBudget: { fileEdits: {}, commandRetries: {}, errorRepeats: {}, recoverTriggers: 0 },
      recentTools: [],
      recentFailures: [],
      verificationPending: false,
      recoverySignals: [],
      lastTrigger: 'manual',
      v2UpdatedAt: new Date(0).toISOString(),
    };

    expect(isRuntimeCheckpointV2(oldRuntimeV2)).toBe(true);
  });

  it('initializes new runtime checkpoint supervisor fields as inert free-mode defaults', () => {
    const checkpoint = emptyRuntimeCheckpointV2();

    expect(checkpoint.supervisorState).toMatchObject({
      executionMode: 'free',
      executionModeLockRemaining: 0,
      executionModeEnteredBy: [],
      executionModeEnteredAtRound: null,
      forcedTaskBearingRoundsSinceEntry: 0,
      pendingModeSignals: [],
    });
  });

  it('allows Batch 1 supervisor shapes to be referenced without runtime wiring', () => {
    const runtimeState: RuntimeExecutionState = {
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
      readonlyToolNames: ['read_file'],
      plannedToolNames: ['read_file'],
      forcedEntryRound: null,
      forcedTaskBearingRoundsSinceEntry: 0,
    };
    const telemetry: ExecutionModeTelemetryPayload = {
      executionMode: 'free',
      enteredBy: [],
      primaryReasonHuman: 'free',
      round: runtimeState.round,
    };
    const config: Pick<SupervisorConfigFile, 'mode' | 'shadow'> = {
      mode: 'adaptive',
      shadow: false,
    };

    expect(telemetry.executionMode).toBe('free');
    expect(config.mode).toBe('adaptive');
  });
});
