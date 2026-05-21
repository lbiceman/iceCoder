import type {
  DeviationSignal,
  HandoffContext,
  ModeParams,
  RecoverySupervisor as RecoverySupervisorContract,
  SupervisorDecision,
  SupervisorEvaluateContext,
  SupervisorMode,
  SupervisorParams,
  SupervisorPhase,
  TakeoverContext,
  TaskContext,
  TaskDomain,
} from '../../types/supervisor.js';
import { formatDeviationSignalReason } from './passive-observer.js';

/**
 * §8.10 — RecoverySupervisor 内部相位快照。
 *
 * `evaluate` 不直接 mutate 实例字段；返回 `{ decision, nextSnapshot }`，由 caller（通常是
 * SupervisorRuntimeBridge）在 **非 shadow** 时显式 `commit(nextSnapshot)`。这样 shadow 段可
 * 完整跑 evaluate 但 **不改 supervisorPhase**，符合附录 B「shadow 只记不接管」。
 */
export interface RecoverySupervisorSnapshot {
  phase: SupervisorPhase;
  /** 进入 takeover 时记录的轮次；handoff/cooldown 期间保留用于遥测。 */
  takeoverStartRound: number;
  /** takeover 期内 **无新偏离信号** 的连续轮数；达到稳定窗口 → handoff_pending。 */
  stableRoundsInTakeover: number;
  /** cooldown 状态下剩余轮数；归零 → 回到 free。 */
  cooldownRemaining: number;
}

export interface RecoverySupervisorEvaluation {
  decision: SupervisorDecision;
  nextSnapshot: RecoverySupervisorSnapshot;
}

const INITIAL_SNAPSHOT: RecoverySupervisorSnapshot = {
  phase: 'free',
  takeoverStartRound: -1,
  stableRoundsInTakeover: 0,
  cooldownRemaining: 0,
};

/**
 * §8.10 RecoverySupervisor —— L2 接管核心（V1 骨架）。
 *
 * 行为约束（与规格 §9 / §18 / 附录 B 一致）：
 *   1. 仅在 `mode='adaptive'` 自由段且 §9 三条件全部满足时进入 takeover；
 *      strict 模式 V1 不在此处接管（其 forced 基线由 ModeDecisionEngine 维护）。
 *   2. 接管期间通过 `applyTakeover` 经 CorrectionPort 注入 **唯一** 的 `kind:'takeover'` 块；
 *      W7 抑制规则仅在 phase=free 抑制 takeover 类，因此本类在调用 inject 前必须先把
 *      phase 推进到 'takeover'（由 bridge.commit(nextSnapshot) 完成）。
 *   3. 稳定窗口 / handoff / cooldown 轮数读取 §17 参数；mode='adaptive' 取 adaptiveTakeover 列，
 *      mode='strict' 取 strict 列；其余回退 strict 列。
 *   4. 接管期间禁止降 free（由 bridge 暴露 phase 给 ModeDecisionEngine 时透传）。
 */
export class RecoverySupervisor implements RecoverySupervisorContract {
  private snapshot: RecoverySupervisorSnapshot = { ...INITIAL_SNAPSHOT };
  private readonly params: SupervisorParams;

  constructor(params: SupervisorParams) {
    this.params = params;
  }

  /** 不 mutate 内部 state；由 caller 选择性 commit。 */
  evaluate(ctx: SupervisorEvaluateContext): SupervisorDecision {
    const { decision, nextSnapshot } = this.computeNext(ctx);
    this.snapshot = nextSnapshot;
    return decision;
  }

  /** evaluate 的 dry-run 版本：返回 { decision, nextSnapshot } 而不 mutate 内部状态。 */
  computeNext(ctx: SupervisorEvaluateContext): RecoverySupervisorEvaluation {
    const current = this.snapshot;

    switch (current.phase) {
      case 'cooldown':
        return this.tickCooldown(current);
      case 'handoff_pending':
        return this.tickHandoffPending(current, ctx);
      case 'takeover':
        return this.tickTakeover(current, ctx);
      case 'free':
      default:
        return this.tickFree(current, ctx);
    }
  }

  /** 在 non-shadow 下由 bridge 调用：原子提交计算结果。 */
  commit(snapshot: RecoverySupervisorSnapshot): void {
    this.snapshot = snapshot;
  }

  getPhase(): SupervisorPhase {
    return this.snapshot.phase;
  }

  getSnapshot(): RecoverySupervisorSnapshot {
    return { ...this.snapshot };
  }

  /**
   * L2-6 / T08 — 由 `SupervisorRuntimeBridge.restoreFromCheckpoint` 调用，将持久化的
   * phase + 计数推回内部状态机。snapshot 缺省时回到 INITIAL（'free'）。
   */
  restoreSnapshot(snapshot: Partial<RecoverySupervisorSnapshot> | undefined): void {
    if (!snapshot) {
      this.snapshot = { ...INITIAL_SNAPSHOT };
      return;
    }
    this.snapshot = {
      phase: snapshot.phase ?? INITIAL_SNAPSHOT.phase,
      takeoverStartRound: snapshot.takeoverStartRound ?? INITIAL_SNAPSHOT.takeoverStartRound,
      stableRoundsInTakeover: snapshot.stableRoundsInTakeover ?? INITIAL_SNAPSHOT.stableRoundsInTakeover,
      cooldownRemaining: snapshot.cooldownRemaining ?? INITIAL_SNAPSHOT.cooldownRemaining,
    };
  }

  applyTakeover(ctx: TakeoverContext): void {
    ctx.correctionPort.inject(
      { kind: 'takeover', content: formatTakeoverMessage(ctx), preserveOnCompaction: true },
      { phase: 'takeover', source: 'supervisor' },
    );
  }

  applyHandoff(ctx: HandoffContext): void {
    ctx.correctionPort?.inject(
      {
        kind: 'graph_hint',
        content: `[Supervisor] Handoff at round ${ctx.round}: control returned to model.`,
      },
      { phase: 'cooldown', source: 'supervisor' },
    );
  }

  // -------------------------- phase transitions --------------------------

  private tickFree(
    snapshot: RecoverySupervisorSnapshot,
    ctx: SupervisorEvaluateContext,
  ): RecoverySupervisorEvaluation {
    // §9 仅 adaptive 走三条件 takeover；strict V1 通过 forced + ModeDecisionEngine 实现。
    if (ctx.mode !== 'adaptive') {
      return { decision: { action: 'continue' }, nextSnapshot: snapshot };
    }

    const conditionOne = isCriticalDomain(ctx.task.domain);
    const conditionTwo = ctx.riskScore >= this.params.adaptiveFree.riskThreshold;
    const conditionThree = hasTriggerSignals(ctx.signals);

    if (!(conditionOne && conditionTwo && conditionThree)) {
      return { decision: { action: 'continue' }, nextSnapshot: snapshot };
    }

    return {
      decision: {
        action: 'takeover',
        reason: formatTakeoverReason(ctx.signals),
        signals: [...ctx.signals],
      },
      nextSnapshot: {
        phase: 'takeover',
        takeoverStartRound: ctx.round.round,
        stableRoundsInTakeover: 0,
        cooldownRemaining: 0,
      },
    };
  }

  private tickTakeover(
    snapshot: RecoverySupervisorSnapshot,
    ctx: SupervisorEvaluateContext,
  ): RecoverySupervisorEvaluation {
    const stable = !hasTriggerSignals(ctx.signals);
    const stableRounds = stable ? snapshot.stableRoundsInTakeover + 1 : 0;
    const window = stabilityWindowFor(ctx.mode, this.params);

    if (stable && stableRounds >= window) {
      // §12.1-12.2 校准完成 → handoff_pending；下一轮再判定 handoff。
      return {
        decision: { action: 'handoff_pending' },
        nextSnapshot: {
          ...snapshot,
          phase: 'handoff_pending',
          stableRoundsInTakeover: stableRounds,
        },
      };
    }

    return {
      decision: { action: 'continue' },
      nextSnapshot: { ...snapshot, stableRoundsInTakeover: stableRounds },
    };
  }

  private tickHandoffPending(
    snapshot: RecoverySupervisorSnapshot,
    ctx: SupervisorEvaluateContext,
  ): RecoverySupervisorEvaluation {
    if (hasTriggerSignals(ctx.signals)) {
      // §12.2 失败 → 继续接管（清零稳定计数）。
      return {
        decision: { action: 'continue' },
        nextSnapshot: { ...snapshot, phase: 'takeover', stableRoundsInTakeover: 0 },
      };
    }

    const cooldown = cooldownRoundsFor(ctx.mode, this.params);
    return {
      decision: { action: 'handoff' },
      nextSnapshot: {
        phase: 'cooldown',
        takeoverStartRound: snapshot.takeoverStartRound,
        stableRoundsInTakeover: 0,
        cooldownRemaining: cooldown,
      },
    };
  }

  private tickCooldown(snapshot: RecoverySupervisorSnapshot): RecoverySupervisorEvaluation {
    const remaining = Math.max(0, snapshot.cooldownRemaining - 1);
    if (remaining > 0) {
      return {
        decision: { action: 'continue' },
        nextSnapshot: { ...snapshot, cooldownRemaining: remaining },
      };
    }
    return {
      decision: { action: 'continue' },
      nextSnapshot: { ...INITIAL_SNAPSHOT },
    };
  }
}

/** §15.3 / §17 — 接管段稳定窗口轮数；adaptive 取 adaptiveTakeover，strict 取 strict。 */
function stabilityWindowFor(mode: SupervisorMode, params: SupervisorParams): number {
  return pickModeParams(mode, params).stabilityWindowRounds;
}

function cooldownRoundsFor(mode: SupervisorMode, params: SupervisorParams): number {
  return pickModeParams(mode, params).handoffCooldownRounds;
}

function pickModeParams(mode: SupervisorMode, params: SupervisorParams): ModeParams {
  if (mode === 'strict') return params.strict;
  return params.adaptiveTakeover;
}

function isCriticalDomain(domain: TaskDomain): boolean {
  return domain.startsWith('critical_');
}

function hasTriggerSignals(signals: readonly DeviationSignal[]): boolean {
  return signals.length > 0;
}

/** Compact reason text used by EventTimeline (`recover` event) and downstream telemetry. */
export function formatTakeoverReason(signals: readonly DeviationSignal[]): string {
  if (signals.length === 0) return 'takeover';
  return signals.map(formatDeviationSignalReason).join(',');
}

function formatTakeoverMessage(ctx: TakeoverContext): string {
  const reasonLine = ctx.reason ? `Reason: ${ctx.reason}` : 'Reason: takeover';
  const signalsLine = ctx.signals.length > 0
    ? `Signals: ${ctx.signals.map(formatDeviationSignalReason).join(', ')}`
    : 'Signals: (none)';
  const domainLine = `Domain: ${ctx.task.domain}`;
  return [
    '[System Recovery]',
    'Supervisor is taking over to stabilize the task graph.',
    reasonLine,
    signalsLine,
    domainLine,
    'Please follow the upcoming recovery hints; do not retry the failing tool with the same arguments.',
  ].join('\n');
}

export function createRecoverySupervisor(params: SupervisorParams): RecoverySupervisor {
  return new RecoverySupervisor(params);
}
