import { STOP_VERIFICATION_TOOL_CALL_PREFIX } from './harness-stop-verification.js';
import type {
  OperationOutcome,
  OperationOutcomeLedger,
} from './operation-outcome.js';

export type CompletionStatus =
  | 'completed'
  | 'completed_unverified'
  | 'paused'
  | 'failed'
  | 'interrupted';

export type CompletionReason =
  | 'settled'
  | 'verification_passed'
  | 'verification_not_required'
  | 'verification_plan_unavailable'
  | 'verification_plan_invalid'
  | 'verification_failed'
  | 'verification_unavailable'
  | 'user_abort'
  | 'user_checkpoint'
  | 'token_budget'
  | 'max_rounds'
  | 'timeout'
  | 'max_output_tokens'
  | 'stop_hook'
  | 'stop_hook_error'
  | 'circuit_breaker'
  | 'error'
  | 'operation_pending'
  | 'operation_user_denied'
  | 'operation_policy_blocked'
  | 'operation_write_failed'
  | 'high_risk_receipt_missing'
  /** 旧 V3 checkpoint 仍可能带这些 reason；运行时不再产生。 */
  | 'condition_pending'
  | 'condition_failed'
  | 'condition_unverifiable'
  | 'operation_failed'
  | 'answer_not_ready'
  | 'settled_without_independent_receipt';

export interface CompletionTerminalDecision {
  status: CompletionStatus;
  reason: CompletionReason;
}

export interface CompletionHardStateDecision extends CompletionTerminalDecision {
  status: 'paused' | 'failed';
  outcome: OperationOutcome;
}

export interface CompletionHardStateOptions {
  /** 早于此时刻的失败 / 拒绝来自旧 run（checkpoint 恢复），不再拦本 run 收尾。 */
  since?: number;
}

/**
 * 返回模型停手前必须服从的确定性操作状态；没有硬状态时返回 null。
 * 验收计划与模型是否已给出正文由 no-tool 主路径另行处理。
 *
 * 失败类状态只看「未解决」项：同 scope 后续成功会在账本里覆盖它；
 * 之后又有一次成功的改动，说明模型已绕开或放弃该操作，也不再拦截。
 */
export function evaluateCompletionHardState(
  ledger: OperationOutcomeLedger | undefined,
  options: CompletionHardStateOptions = {},
): CompletionHardStateDecision | null {
  const all = (ledger?.list() ?? []).filter(outcome =>
    !outcome.toolCallId.startsWith(STOP_VERIFICATION_TOOL_CALL_PREFIX),
  );
  const lastProgressAt = all.reduce(
    (at, outcome) => (isSuccessfulMutation(outcome) ? Math.max(at, outcome.at) : at),
    Number.NEGATIVE_INFINITY,
  );
  const since = options.since ?? Number.NEGATIVE_INFINITY;
  const unresolved = all.filter(outcome =>
    outcome.at >= since
    && (outcome.status !== 'failed' || outcome.at >= lastProgressAt),
  );
  const latestOf = (
    outcomes: OperationOutcome[],
    predicate: (outcome: OperationOutcome) => boolean,
  ) => [...outcomes].reverse().find(predicate);
  const latest = (predicate: (outcome: OperationOutcome) => boolean) =>
    latestOf(unresolved, predicate);

  const pending = latestOf(all, outcome =>
    outcome.status === 'pending' || outcome.status === 'awaiting_approval',
  );
  if (pending) {
    return {
      status: 'paused',
      reason: 'operation_pending',
      outcome: pending,
    };
  }

  const denied = latest(outcome =>
    outcome.status === 'failed' && outcome.disposition === 'user_denied',
  );
  if (denied) {
    return {
      status: 'paused',
      reason: 'operation_user_denied',
      outcome: denied,
    };
  }

  const policyBlocked = latest(outcome =>
    outcome.status === 'failed' && outcome.disposition === 'policy_block',
  );
  if (policyBlocked) {
    return {
      status: 'paused',
      reason: 'operation_policy_blocked',
      outcome: policyBlocked,
    };
  }

  const failedWrite = latest(outcome =>
    outcome.status === 'failed'
    && outcome.disposition !== 'user_denied'
    && outcome.disposition !== 'policy_block'
    && (
      outcome.effect === 'local_change'
      || outcome.effect === 'external_change'
      || (outcome.effect === 'execute' && outcome.risk === 'high')
    ),
  );
  if (failedWrite) {
    return {
      status: 'failed',
      reason: 'operation_write_failed',
      outcome: failedWrite,
    };
  }

  const missingReceipt = latest(outcome =>
    outcome.status === 'completed'
    && outcome.risk === 'high'
    && !hasUsableReceipt(outcome),
  );
  if (missingReceipt) {
    return {
      status: 'paused',
      reason: 'high_risk_receipt_missing',
      outcome: missingReceipt,
    };
  }

  return null;
}

function isSuccessfulMutation(outcome: OperationOutcome): boolean {
  return outcome.status === 'completed'
    && outcome.disposition === 'executed'
    && outcome.effect !== 'observe';
}

function hasUsableReceipt(outcome: OperationOutcome): boolean {
  const receipt = outcome.receipt;
  return !!receipt && (
    !!receipt.operationId
    || receipt.exitCode !== undefined
    || !!receipt.version
    || !!receipt.summary
  );
}
