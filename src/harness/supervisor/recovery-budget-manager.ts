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
  /** 触发耗尽时的具体计数，便于 timeline / UI 显示。 */
  detail?: {
    roundsUsed: number;
    maxRounds: number;
    tokenRatioUsed: number;
    maxTokenRatio: number;
    maxRetryCount: number;
    maxRetries: number;
  };
}

interface RecoveryBudgetState {
  active: boolean;
  startRound: number;
  roundsUsed: number;
  /** 最近一次 tick 的轮次，避免同轮重复 ++。 */
  lastTickedRound: number;
  tokenRatioUsed: number;
  retryCounts: Map<string, number>;
  budget: ModeParams;
}

const INITIAL_STATE: Omit<RecoveryBudgetState, 'budget'> = {
  active: false,
  startRound: -1,
  roundsUsed: 0,
  lastTickedRound: -1,
  tokenRatioUsed: 0,
  retryCounts: new Map(),
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
      budget: pickModeBudget(mode, this.params),
    };
  }

  /** takeover 中每轮调用一次；同轮幂等。off / 非 takeover 时静默。 */
  tickRound(round: number): void {
    if (!this.state.active) return;
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

    if (this.state.roundsUsed > this.state.budget.maxRecoveryRounds) {
      return { exhausted: true, reason: 'max_recovery_rounds', detail };
    }
    if (this.state.tokenRatioUsed > this.state.budget.recoveryTokenRatio) {
      return { exhausted: true, reason: 'recovery_token_ratio', detail };
    }
    if (this.maxRetryCount() > this.state.budget.maxRecoveryRetries) {
      return { exhausted: true, reason: 'max_recovery_retries', detail };
    }

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
  } {
    return {
      active: this.state.active,
      startRound: this.state.startRound,
      ...this.snapshotDetail(),
    };
  }

  private snapshotDetail(): NonNullable<RecoveryBudgetEvaluation['detail']> {
    return {
      roundsUsed: this.state.roundsUsed,
      maxRounds: this.state.budget.maxRecoveryRounds,
      tokenRatioUsed: this.state.tokenRatioUsed,
      maxTokenRatio: this.state.budget.recoveryTokenRatio,
      maxRetryCount: this.maxRetryCount(),
      maxRetries: this.state.budget.maxRecoveryRetries,
    };
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
