import { describe, expect, it } from 'vitest';

import {
  ModeDecisionEngine,
  formatForcedReasonHuman,
  shouldExitForcedMode,
  sortSignalsByPrecedence,
} from '../../src/harness/supervisor/mode-decision-engine.js';
import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import type {
  ModeDecisionContext,
  ModeSignal,
  RuntimeExecutionState,
} from '../../src/types/supervisor.js';

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
    stableRounds: cfg.stableRoundsExitThreshold,
    activeGraphHasImplementNode: false,
    readonlyToolNames: cfg.readonlyToolNames,
    plannedToolNames: [],
    forcedEntryRound: null,
    forcedTaskBearingRoundsSinceEntry: cfg.forcedMinDwellRounds,
    ...overrides,
  };
}

function context(overrides: Partial<ModeDecisionContext> = {}): ModeDecisionContext {
  const runtimeState = overrides.state ?? state();
  return {
    round: runtimeState.round,
    executionMode: 'free',
    executionModeLockRemaining: 0,
    supervisorPhase: 'free',
    supervisorMode: 'adaptive',
    riskLevel: 'L0_observation',
    state: runtimeState,
    signals: [],
    ...overrides,
  };
}

describe('ModeDecisionEngine - Batch 2', () => {
  it('sorts enter signals by frozen precedence and excludes recovery_pending', () => {
    const signals: ModeSignal[] = ['pending_steps', 'recovery_pending', 'checkpoint_resumed', 'multi_write'];

    expect(sortSignalsByPrecedence(signals)).toEqual([
      'checkpoint_resumed',
      'pending_steps',
      'multi_write',
    ]);
  });

  it('enters forced with ordered enteredBy and a human reason', () => {
    const engine = new ModeDecisionEngine(cfg);

    const decision = engine.evaluate(context({
      state: state({ pendingStepCount: cfg.pendingStepsEnterThreshold, checkpointResumedThisSession: true }),
      signals: ['pending_steps', 'checkpoint_resumed'],
    }));

    expect(decision).toMatchObject({
      action: 'enter_forced',
      lockRounds: cfg.modeLockRounds,
      enteredBy: ['checkpoint_resumed', 'pending_steps'],
      primaryReason: 'checkpoint_resumed',
    });
    expect(formatForcedReasonHuman(['checkpoint_resumed', 'pending_steps'])).toBe('forced because checkpoint_resumed + pending_steps');
  });

  it('keeps forced while mode lock remains even when exit conditions are true', () => {
    const engine = new ModeDecisionEngine(cfg);

    const decision = engine.evaluate(context({
      executionMode: 'forced',
      executionModeLockRemaining: 1,
      state: state(),
    }));

    expect(decision).toEqual({ action: 'keep', mode: 'forced' });
  });

  it('keeps forced until I10 minimum task-bearing dwell is satisfied', () => {
    const runtimeState = state({ forcedTaskBearingRoundsSinceEntry: cfg.forcedMinDwellRounds - 1 });

    expect(shouldExitForcedMode(runtimeState, cfg, 0, [])).toBe(false);

    const engine = new ModeDecisionEngine(cfg);
    expect(engine.evaluate(context({
      executionMode: 'forced',
      state: runtimeState,
    }))).toEqual({ action: 'keep', mode: 'forced' });
  });

  it('lets recovery_pending block exit without acting as an enter reason', () => {
    const engine = new ModeDecisionEngine(cfg);

    expect(engine.evaluate(context({ signals: ['recovery_pending'] }))).toEqual({ action: 'keep', mode: 'free' });
    expect(engine.evaluate(context({
      executionMode: 'forced',
      state: state({ recoveryPending: true }),
      signals: ['recovery_pending'],
    }))).toEqual({ action: 'keep', mode: 'forced' });
  });

  it('exits forced only after lock, dwell, stability, no recovery, and no branch debt', () => {
    const engine = new ModeDecisionEngine(cfg);

    expect(engine.evaluate(context({
      executionMode: 'forced',
      executionModeLockRemaining: 0,
      state: state(),
    }))).toEqual({ action: 'exit_forced', reason: 'stable' });
  });

  it('falls back to forced when evaluate internals throw', () => {
    class ThrowingEngine extends ModeDecisionEngine {
      protected override evaluateOrThrow(): never {
        throw new Error('boom');
      }
    }

    const decision = new ThrowingEngine(cfg).evaluate(context());

    expect(decision).toMatchObject({
      action: 'enter_forced',
      enteredBy: ['engine_fail_safe'],
      primaryReason: 'engine_fail_safe',
      failSafe: true,
    });
  });
});
