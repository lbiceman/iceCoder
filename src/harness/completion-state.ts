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

/**
 * 返回模型停手前必须服从的确定性操作状态；没有硬状态时返回 null。
 * 验收计划与模型是否已给出正文由 no-tool 主路径另行处理。
 */
export function evaluateCompletionHardState(
  ledger: OperationOutcomeLedger | undefined,
): CompletionHardStateDecision | null {
  const outcomes = ledger?.list() ?? [];
  const latest = (predicate: (outcome: OperationOutcome) => boolean) =>
    [...outcomes].reverse().find(predicate);

  const pending = latest(outcome =>
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

function hasUsableReceipt(outcome: OperationOutcome): boolean {
  const receipt = outcome.receipt;
  return !!receipt && (
    !!receipt.operationId
    || receipt.exitCode !== undefined
    || !!receipt.version
    || !!receipt.summary
  );
}
