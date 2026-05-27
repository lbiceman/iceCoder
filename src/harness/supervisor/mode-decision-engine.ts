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

/**
 * W3 — L0 短路时只保留外部硬信号（绕过 state 派生）。
 * 复用 sortSignalsByPrecedence，但不读取 RuntimeExecutionState。
 */
function sortExternalEnterSignals(signals: ModeSignal[]): ModeSignal[] {
  return sortSignalsByPrecedence(signals);
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
  // lastToolSuccess=false 当 consecutiveToolFailures>0（整轮可执行工具全失败）；benchmark 长任务里
  // 往往先有 npm test 红，而非 edit 执行器故障。与 step_gate 显式 submit 的 tool_failure 可叠加。
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
    } finally {
      this.submittedSignals.length = 0;
    }
  }

  submitSignal(source: ModeSignalSource, signal: ModeSignal, payload?: Record<string, unknown>): void {
    this.submittedSignals.push({ source, signal, payload });
  }

  getSubmittedSignals(): readonly SubmittedModeSignal[] {
    return this.submittedSignals;
  }

  /**
   * 清空尚未被 evaluate 消费的 submittedSignals。
   *
   * 仅在 Harness 实例跨 run() 复用、且上次 run 末尾未触发 evaluate
   * (熔断 / max_rounds / abort) 时使用，避免上一次 run 的残留信号
   * 污染下一次 run 的首轮 evaluate（W1 修复）。
   */
  resetSubmittedSignals(): void {
    this.submittedSignals.length = 0;
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
      const strictFloorSignals: ModeSignal[] = ctx.supervisorMode === 'strict' ? ['explicit_impl'] : [];
      // W3: L0 只读计划在 adaptive 下不补任何"运行态派生"信号，
      //     但**外部 submit 的硬信号**（checkpoint_resumed / branch_switched /
      //     tool_failure / explicit_impl）仍然能触发 enter。
      //     这样 classifier 真正影响"是否因 state 升级 forced"，
      //     而不会越权屏蔽外部硬信号；strict floor 仍由专门通道注入。
      const skipStateDerivedEnter = ctx.supervisorMode === 'adaptive'
        && ctx.riskLevel === 'L0_observation';
      const enteredBy = skipStateDerivedEnter
        ? sortExternalEnterSignals([...signals, ...strictFloorSignals])
        : shouldEnterForcedMode(ctx.state, this.config, [...signals, ...strictFloorSignals]);
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
