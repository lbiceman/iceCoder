import type {
  ExecutionModeConfig,
  ModeDecision,
  ModeDecisionContext,
  ModeDecisionEngine as ModeDecisionEngineContract,
  ModeSignal,
  ModeSignalSource,
  RuntimeExecutionState,
} from '../../types/supervisor.js';
import { MODE_SIGNAL_PRECEDENCE } from '../../types/supervisor.js';

const ENTER_SIGNAL_SET = new Set<ModeSignal>(MODE_SIGNAL_PRECEDENCE);

export function sortSignalsByPrecedence(signals: ModeSignal[]): ModeSignal[] {
  const seen = new Set<ModeSignal>();
  const enterSignals = signals.filter((signal) => {
    if (!ENTER_SIGNAL_SET.has(signal) || seen.has(signal)) return false;
    seen.add(signal);
    return true;
  });

  return enterSignals.sort(
    (a, b) => MODE_SIGNAL_PRECEDENCE.indexOf(a) - MODE_SIGNAL_PRECEDENCE.indexOf(b),
  );
}

export function formatForcedReasonHuman(enteredBy: ModeSignal[]): string {
  if (enteredBy.length === 0) return 'free';
  return `forced because ${enteredBy.join(' + ')}`;
}

export function shouldEnterForcedMode(
  state: RuntimeExecutionState,
  config: ExecutionModeConfig,
  signals: ModeSignal[] = [],
): ModeSignal[] {
  const reasons: ModeSignal[] = [...signals];
  if (state.taskGraphActive) reasons.push('task_graph_active');
  if (state.pendingStepCount >= config.pendingStepsEnterThreshold) reasons.push('pending_steps');
  if (
    state.writeTargetsThisRound > config.writeTargetsEnterThreshold
    || state.plannedWriteTargets > config.writeTargetsEnterThreshold
  ) {
    reasons.push('multi_write');
  }
  if (state.branchSwitchedThisRound) reasons.push('branch_switched');
  if (state.checkpointResumedThisSession) reasons.push('checkpoint_resumed');
  if (!state.lastToolSuccess) reasons.push('tool_failure');
  if (state.accumulatedDiffLines > config.diffLinesEnterThreshold) reasons.push('large_diff');
  if (state.activeGraphHasImplementNode) reasons.push('explicit_impl');
  return sortSignalsByPrecedence(reasons);
}

export function shouldExitForcedMode(
  state: RuntimeExecutionState,
  config: ExecutionModeConfig,
  executionModeLockRemaining: number,
  signals: ModeSignal[] = [],
): boolean {
  if (executionModeLockRemaining > 0) return false;
  if (state.forcedTaskBearingRoundsSinceEntry < config.forcedMinDwellRounds) return false;
  return state.pendingStepCount === 0
    && state.plannedWriteTargets === 0
    && state.stableRounds >= config.stableRoundsExitThreshold
    && !state.recoveryPending
    && !signals.includes('recovery_pending')
    && state.branchDebt === 0;
}

interface SubmittedModeSignal {
  source: ModeSignalSource;
  signal: ModeSignal;
  payload?: Record<string, unknown>;
}

export class ModeDecisionEngine implements ModeDecisionEngineContract {
  private readonly submittedSignals: SubmittedModeSignal[] = [];

  constructor(private readonly config: ExecutionModeConfig) {}

  evaluate(ctx: ModeDecisionContext): ModeDecision {
    try {
      return this.evaluateOrThrow(ctx);
    } catch {
      return {
        action: 'enter_forced',
        reason: ['engine_fail_safe'],
        lockRounds: this.config.modeLockRounds,
        enteredBy: ['engine_fail_safe'],
        primaryReason: 'engine_fail_safe',
        failSafe: true,
      };
    }
  }

  submitSignal(source: ModeSignalSource, signal: ModeSignal, payload?: Record<string, unknown>): void {
    this.submittedSignals.push({ source, signal, payload });
  }

  getSubmittedSignals(): readonly SubmittedModeSignal[] {
    return this.submittedSignals;
  }

  protected evaluateOrThrow(ctx: ModeDecisionContext): ModeDecision {
    const signals = [
      ...ctx.signals,
      ...this.submittedSignals.map(entry => entry.signal),
    ];

    if (ctx.supervisorMode === 'off') {
      return { action: 'keep', mode: 'free' };
    }

    if (ctx.executionMode !== 'forced') {
      const enteredBy = shouldEnterForcedMode(ctx.state, this.config, signals);
      if (enteredBy.length > 0) {
        return {
          action: 'enter_forced',
          reason: enteredBy,
          lockRounds: this.config.modeLockRounds,
          enteredBy,
          primaryReason: enteredBy[0],
        };
      }
      return { action: 'keep', mode: ctx.executionMode };
    }

    if (shouldExitForcedMode(ctx.state, this.config, ctx.executionModeLockRemaining, signals)) {
      return { action: 'exit_forced', reason: 'stable' };
    }
    return { action: 'keep', mode: 'forced' };
  }
}
