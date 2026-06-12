import type {
  ModeParams,
  SupervisorMode,
  SupervisorParams,
} from '../../types/supervisor.js';

/**
 * §8.8 RecoveryBudgetManager —— 限制单次 takeover 的恢复成本。
 *
 * 三维预算（来自 §17 / `SupervisorParams.adaptiveTakeover` | `strict`）：
 *   - `maxRecoveryRounds`：本次接管允许的恢复轮数；
 *   - `recoveryTokenRatio`：恢复阶段累计 token 占任务总预算的比例上限 [0,1]；
 *   - `maxRecoveryRetries`：同路径/同工具签名上的恢复重试次数上限。
 *
 * 任一维度耗尽 → `evaluate()` 返回 `{ exhausted: true, reason }`；调用方（通常是
 * `SupervisorRuntimeBridge`）应将其映射为 `SupervisorDecision.fail{ kind: 'checkpoint' }`，
 * 进而被 Harness 落为 `stopReason: 'user_checkpoint'`（附录 A）。
 *
 * 实例对象与单次 takeover 周期绑定：
 *   - `beginTakeover(round, mode)`：state 复位 + 抓取对应 mode 列的预算；
 *   - `tickRound(round)`：takeover 段每轮 ++；同一轮重复调用幂等；
 *   - `recordTokenUsage(used, total)`：累计 token 占比；
 *   - `recordRetry(signature)`：同 signature 上的重试 +1；
 *   - `reset()`：handoff/cooldown 后清空。
 *
 * Off / 未接管时各 record* 调用安全无副作用；evaluate() 永远返回 not-exhausted。
 */

export type RecoveryBudgetExhaustionReason =
  | 'max_recovery_rounds'
  | 'recovery_token_ratio'
  | 'max_recovery_retries';

export interface RecoveryBudgetEvaluation {
  exhausted: boolean;
  reason?: RecoveryBudgetExhaustionReason;
  /** 本轮 evaluate 是否刚授予了轮数扩展（进展感知 deferral）。 */
  extended?: boolean;
  /** 触发耗尽时的具体计数，便于 timeline / UI 显示。 */
  detail?: {
    roundsUsed: number;
    maxRounds: number;
    tokenRatioUsed: number;
    maxTokenRatio: number;
    maxRetryCount: number;
    maxRetries: number;
    roundExtensionsGranted: number;
  };
}

/** 进展感知：最近 N 轮 effective 滑动窗口。 */
const RECENT_EFFECTIVE_WINDOW = 5;
/** token 低于此比例且仍有进展时，允许一次轮数扩展。 */
const PROGRESS_TOKEN_RATIO_THRESHOLD = 0.1;
/** 单次 takeover 最多扩展次数。 */
const MAX_ROUND_EXTENSIONS = 1;
/** 绝对硬顶 = maxRecoveryRounds × 此倍数（含扩展后）。 */
const ABSOLUTE_ROUND_HARD_CAP_MULTIPLIER = 2;

interface RecoveryBudgetState {
  active: boolean;
  startRound: number;
  roundsUsed: number;
  /** 最近一次 tick 的轮次，避免同轮重复 ++。 */
  lastTickedRound: number;
  tokenRatioUsed: number;
  retryCounts: Map<string, number>;
  budget: ModeParams;
  /** 最近 tick 的 effective 标记（用于进展感知 exhaustion）。 */
  recentEffective: boolean[];
  roundExtensionsGranted: number;
}

const INITIAL_STATE: Omit<RecoveryBudgetState, 'budget'> = {
  active: false,
  startRound: -1,
  roundsUsed: 0,
  lastTickedRound: -1,
  tokenRatioUsed: 0,
  retryCounts: new Map(),
  recentEffective: [],
  roundExtensionsGranted: 0,
};

export class RecoveryBudgetManager {
  private readonly params: SupervisorParams;
  private state: RecoveryBudgetState;

  constructor(params: SupervisorParams) {
    this.params = params;
    this.state = { ...INITIAL_STATE, retryCounts: new Map(), budget: params.adaptiveTakeover };
  }

  /** 进入 takeover 时调用：复位计数并锁定 mode 列。 */
  beginTakeover(round: number, mode: SupervisorMode): void {
    this.state = {
      active: true,
      startRound: round,
      roundsUsed: 0,
      lastTickedRound: -1,
      tokenRatioUsed: 0,
      retryCounts: new Map(),
      recentEffective: [],
      roundExtensionsGranted: 0,
      budget: pickModeBudget(mode, this.params),
    };
  }

  /** takeover 中每轮调用一次；同轮幂等。effective=false 时不计数（无效空转轮）。 */
  tickRound(round: number, effective = true): void {
    if (!this.state.active) return;
    this.pushRecentEffective(effective);
    if (!effective) return;
    if (round <= this.state.lastTickedRound) return;
    this.state.lastTickedRound = round;
    this.state.roundsUsed += 1;
  }

  /**
   * 累计 token 使用率；`total <= 0` 时按 0 处理（防止 NaN/Infinity）。
   * `used` / `total` 单位由调用方约定（V1 推荐 outputTokens；总预算来自 LoopState 上限）。
   */
  recordTokenUsage(used: number, total: number): void {
    if (!this.state.active) return;
    if (total <= 0) return;
    const ratio = Math.max(0, used / total);
    if (Number.isFinite(ratio)) {
      this.state.tokenRatioUsed = Math.max(this.state.tokenRatioUsed, ratio);
    }
  }

  /** 同路径恢复重试 +1；signature 由调用方约定（建议 `${tool}:${arg-hash}`）。 */
  recordRetry(signature: string): void {
    if (!this.state.active) return;
    if (!signature) return;
    const prev = this.state.retryCounts.get(signature) ?? 0;
    this.state.retryCounts.set(signature, prev + 1);
  }

  /** 当前是否仍处于 takeover 预算计数中。 */
  isActive(): boolean {
    return this.state.active;
  }

  /** 评估三维预算；任一维超限 → exhausted=true。 */
  evaluate(): RecoveryBudgetEvaluation {
    if (!this.state.active) return { exhausted: false };

    const detail = this.snapshotDetail();

    if (this.state.tokenRatioUsed > this.state.budget.recoveryTokenRatio) {
      return { exhausted: true, reason: 'recovery_token_ratio', detail };
    }
    if (this.maxRetryCount() > this.state.budget.maxRecoveryRetries) {
      return { exhausted: true, reason: 'max_recovery_retries', detail };
    }

    const roundsResult = this.evaluateRecoveryRounds(detail);
    if (roundsResult) return roundsResult;

    return { exhausted: false, detail };
  }

  /** handoff / cooldown 后调用；清空所有计数并解除 active。 */
  reset(): void {
    this.state = { ...INITIAL_STATE, retryCounts: new Map(), budget: this.state.budget };
  }

  /** 调试 / timeline 输出用。 */
  snapshot(): {
    active: boolean;
    startRound: number;
    roundsUsed: number;
    maxRounds: number;
    tokenRatioUsed: number;
    maxTokenRatio: number;
    maxRetryCount: number;
    maxRetries: number;
    roundExtensionsGranted: number;
  } {
    return {
      active: this.state.active,
      startRound: this.state.startRound,
      ...this.snapshotDetail(),
    };
  }

  private snapshotDetail(): NonNullable<RecoveryBudgetEvaluation['detail']> {
    const baseMax = this.state.budget.maxRecoveryRounds;
    const effectiveMax = baseMax * (1 + this.state.roundExtensionsGranted);
    return {
      roundsUsed: this.state.roundsUsed,
      maxRounds: effectiveMax,
      tokenRatioUsed: this.state.tokenRatioUsed,
      maxTokenRatio: this.state.budget.recoveryTokenRatio,
      maxRetryCount: this.maxRetryCount(),
      maxRetries: this.state.budget.maxRecoveryRetries,
      roundExtensionsGranted: this.state.roundExtensionsGranted,
    };
  }

  /**
   * 轮数维：超过 soft max 时，若仍有进展且 token 消耗低则扩展一次；
   * 绝对硬顶 = maxRecoveryRounds × ABSOLUTE_ROUND_HARD_CAP_MULTIPLIER × (1 + extensions)。
   */
  private evaluateRecoveryRounds(
    detail: NonNullable<RecoveryBudgetEvaluation['detail']>,
  ): RecoveryBudgetEvaluation | null {
    const baseMax = this.state.budget.maxRecoveryRounds;
    if (this.state.roundsUsed <= baseMax) return null;

    if (
      this.state.roundExtensionsGranted < MAX_ROUND_EXTENSIONS
      && this.state.tokenRatioUsed < PROGRESS_TOKEN_RATIO_THRESHOLD
      && this.hasRecentProgress()
    ) {
      this.state.roundExtensionsGranted += 1;
      return { exhausted: false, extended: true, detail: this.snapshotDetail() };
    }

    const hardCap = baseMax * ABSOLUTE_ROUND_HARD_CAP_MULTIPLIER * (1 + this.state.roundExtensionsGranted);
    if (this.state.roundsUsed > hardCap) {
      return { exhausted: true, reason: 'max_recovery_rounds', detail: this.snapshotDetail() };
    }

    const effectiveMax = baseMax * (1 + this.state.roundExtensionsGranted);
    if (this.state.roundsUsed > effectiveMax && this.allRecentIneffective()) {
      return { exhausted: true, reason: 'max_recovery_rounds', detail: this.snapshotDetail() };
    }

    return null;
  }

  private pushRecentEffective(effective: boolean): void {
    this.state.recentEffective.push(effective);
    if (this.state.recentEffective.length > RECENT_EFFECTIVE_WINDOW) {
      this.state.recentEffective.shift();
    }
  }

  private hasRecentProgress(): boolean {
    return this.state.recentEffective.some(Boolean);
  }

  private allRecentIneffective(): boolean {
    return this.state.recentEffective.length >= RECENT_EFFECTIVE_WINDOW
      && this.state.recentEffective.every(v => !v);
  }

  private maxRetryCount(): number {
    let max = 0;
    for (const count of this.state.retryCounts.values()) {
      if (count > max) max = count;
    }
    return max;
  }
}

function pickModeBudget(mode: SupervisorMode, params: SupervisorParams): ModeParams {
  if (mode === 'strict') return params.strict;
  return params.adaptiveTakeover;
}

export function createRecoveryBudgetManager(params: SupervisorParams): RecoveryBudgetManager {
  return new RecoveryBudgetManager(params);
}

/** 将 exhaustion reason 折为 timeline / decision 可读字符串。 */
export function formatBudgetExhaustionReason(reason: RecoveryBudgetExhaustionReason): string {
  switch (reason) {
    case 'max_recovery_rounds':
      return 'budget_exhausted:rounds';
    case 'recovery_token_ratio':
      return 'budget_exhausted:tokens';
    case 'max_recovery_retries':
      return 'budget_exhausted:retries';
  }
}
