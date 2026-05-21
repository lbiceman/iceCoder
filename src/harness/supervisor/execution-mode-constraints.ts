import type { LoopController } from '../loop-controller.js';
import type { RuntimeTelemetry } from '../runtime-telemetry.js';
import type { HarnessRunState } from '../harness-run-state.js';
import type { HarnessStepEvent } from '../types.js';
import type {
  ExecutionModeConfig,
  ExecutionModeTelemetryPayload,
  ForcedDegradedTier,
  ModeDecision,
  TaskBearingRoundOutcome,
} from '../../types/supervisor.js';
import { formatForcedReasonHuman } from './mode-decision-engine.js';

export interface ApplyExecutionModeConstraintsDeps {
  loopController: LoopController;
  runtimeTelemetry?: RuntimeTelemetry;
  /**
   * §2.8 / T12 — execution mode 切换时同步 branch budget / checkpoint forced policy。
   * 实现方按 nextMode 启停子模块；仅由本函数调用，避免散落的 ExecutionMode 写入。
   */
  onExecutionModeChanged?: (nextMode: 'free' | 'forced') => void;
}

export interface ApplyExecutionModeConstraintsArgs {
  state: HarnessRunState;
  decision: ModeDecision;
  round: number;
  config: ExecutionModeConfig;
  onStep?: (event: HarnessStepEvent) => void;
}

export function applyExecutionModeConstraints(
  deps: ApplyExecutionModeConstraintsDeps,
  args: ApplyExecutionModeConstraintsArgs,
): void {
  const { state, decision, round, config, onStep } = args;
  normalizeExecutionModeState(state);
  state.lastModeDecision = decision;

  if (decision.action === 'enter_forced') {
    state.executionMode = 'forced';
    state.executionModeLockRemaining = decision.lockRounds;
    state.executionModeEnteredBy = [...decision.enteredBy];
    state.executionModeEnteredByPrimary = decision.primaryReason;
    state.executionModeEnteredAtRound = round;
    state.forcedTaskBearingRoundsSinceEntry = 0;

    const payload = buildTelemetryPayload(state, round, config, decision.failSafe);
    onStep?.({ type: 'execution_mode_enter', iteration: round, executionMode: payload });
    deps.runtimeTelemetry?.recordExecutionMode('execution_mode_enter', payload);
    deps.onExecutionModeChanged?.('forced');
    syncExecutionModeLoopState(deps.loopController, state);
    return;
  }

  if (decision.action === 'exit_forced') {
    const enteredBy = state.executionModeEnteredBy ?? [];
    const primary = state.executionModeEnteredByPrimary;
    const payload: ExecutionModeTelemetryPayload = {
      executionMode: 'free',
      enteredBy: [...enteredBy],
      enteredByPrimary: primary,
      primaryReasonHuman: formatForcedReasonHuman(enteredBy),
      round,
      forcedTaskBearingRoundsSinceEntry: state.forcedTaskBearingRoundsSinceEntry ?? 0,
      forcedMinDwellRounds: config.forcedMinDwellRounds,
    };

    state.executionMode = 'free';
    state.executionModeLockRemaining = 0;
    state.executionModeEnteredBy = [];
    state.executionModeEnteredByPrimary = undefined;
    state.executionModeEnteredAtRound = undefined;
    state.forcedDegradedTier = undefined;
    state.forcedTaskBearingRoundsSinceEntry = 0;
    // W4: forced 退出意味着 supervisor 接管完成，清掉 recovery sticky。
    state.recoveryPendingSticky = false;

    onStep?.({ type: 'execution_mode_exit', iteration: round, executionMode: payload });
    deps.runtimeTelemetry?.recordExecutionMode('execution_mode_exit', payload);
    deps.onExecutionModeChanged?.('free');
    syncExecutionModeLoopState(deps.loopController, state);
    return;
  }

  state.executionMode = decision.mode;
  if (decision.mode === 'forced' && (state.executionModeLockRemaining ?? 0) > 0) {
    state.executionModeLockRemaining = Math.max(0, (state.executionModeLockRemaining ?? 0) - 1);
  }
  syncExecutionModeLoopState(deps.loopController, state);
}

export function isTaskBearingRound(outcome: TaskBearingRoundOutcome): boolean {
  return outcome.hadSuccessfulToolExecute
    || outcome.graphStepAdvanced
    || outcome.writeToolSucceededWithFileChange;
}

export function recordTaskBearingRoundIfForced(
  state: HarnessRunState,
  outcome: TaskBearingRoundOutcome,
  _config: ExecutionModeConfig,
): boolean {
  normalizeExecutionModeState(state);
  if (state.executionMode !== 'forced' || !isTaskBearingRound(outcome)) {
    return false;
  }
  state.forcedTaskBearingRoundsSinceEntry = (state.forcedTaskBearingRoundsSinceEntry ?? 0) + 1;
  return true;
}

export function markForcedDegraded(state: HarnessRunState, tier: ForcedDegradedTier): boolean {
  normalizeExecutionModeState(state);
  if (state.executionMode !== 'forced') {
    return false;
  }

  state.forcedDegradedTier = tier;
  return true;
}

export function syncExecutionModeLoopState(loopController: LoopController, state: HarnessRunState): void {
  loopController.updateExecutionModeState({
    executionMode: state.executionMode ?? 'free',
    executionModeLockRemaining: state.executionModeLockRemaining ?? 0,
    executionModeEnteredBy: [...(state.executionModeEnteredBy ?? [])],
    executionModeEnteredByPrimary: state.executionModeEnteredByPrimary,
    executionModeEnteredAtRound: state.executionModeEnteredAtRound,
    forcedDegradedTier: state.forcedDegradedTier,
    lastModeDecision: state.lastModeDecision,
    pendingModeSignals: [...(state.pendingModeSignals ?? [])],
    forcedTaskBearingRoundsSinceEntry: state.forcedTaskBearingRoundsSinceEntry ?? 0,
    supervisorPhase: state.supervisorPhase,
  });
}

function normalizeExecutionModeState(state: HarnessRunState): void {
  state.executionMode ??= 'free';
  state.executionModeLockRemaining ??= 0;
  state.executionModeEnteredBy ??= [];
  state.pendingModeSignals ??= [];
  state.forcedTaskBearingRoundsSinceEntry ??= 0;
  state.supervisorPhase ??= 'free';
}

function buildTelemetryPayload(
  state: HarnessRunState,
  round: number,
  config: ExecutionModeConfig,
  failSafe?: boolean,
): ExecutionModeTelemetryPayload {
  const enteredBy = state.executionModeEnteredBy ?? [];
  return {
    executionMode: state.executionMode ?? 'free',
    enteredBy: [...enteredBy],
    enteredByPrimary: state.executionModeEnteredByPrimary,
    primaryReasonHuman: formatForcedReasonHuman(enteredBy),
    round,
    failSafe,
    degradedTier: state.forcedDegradedTier,
    forcedTaskBearingRoundsSinceEntry: state.forcedTaskBearingRoundsSinceEntry ?? 0,
    forcedMinDwellRounds: config.forcedMinDwellRounds,
  };
}
