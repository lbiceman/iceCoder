import type { OperationOutcome, OperationOutcomeLedger } from './operation-outcome.js';

export type CompletionStatus =
  | 'completed'
  | 'completed_unverified'
  | 'paused'
  | 'failed'
  | 'interrupted';

export type CompletionGateAction = 'complete' | 'continue' | 'pause' | 'fail';

export interface CompletionGateInput {
  ledger?: OperationOutcomeLedger;
  explicitConditionsPending?: boolean;
  recoveryCount?: number;
  evidenceRequestCount?: number;
}

export interface CompletionGateDecision {
  action: CompletionGateAction;
  status: CompletionStatus;
  reason:
    | 'explicit_condition_pending'
    | 'operation_pending'
    | 'operation_failed'
    | 'high_risk_receipt_missing'
    | 'settled'
    | 'settled_without_independent_receipt';
  prompt?: string;
  outcome?: OperationOutcome;
}

/**
 * 与语言和工具名无关的收尾判定。它只消费标准化操作状态；
 * 测试、截图、文件读取等是否值得执行，交给模型的软提示判断。
 */
export class CompletionGate {
  evaluate(input: CompletionGateInput): CompletionGateDecision {
    if (input.explicitConditionsPending) {
      return {
        action: 'continue',
        status: 'paused',
        reason: 'explicit_condition_pending',
      };
    }

    const pending = input.ledger?.latestPending();
    if (pending) {
      return {
        action: 'pause',
        status: 'paused',
        reason: 'operation_pending',
        outcome: pending,
      };
    }

    const failure = input.ledger?.latestUnresolvedFailure();
    if (failure) {
      if ((input.recoveryCount ?? 0) < 1 && failure.disposition !== 'user_denied') {
        return {
          action: 'continue',
          status: 'failed',
          reason: 'operation_failed',
          outcome: failure,
          prompt: buildFailurePrompt(failure),
        };
      }
      return {
        action: failure.disposition === 'user_denied' ? 'pause' : 'fail',
        status: failure.disposition === 'user_denied' ? 'paused' : 'failed',
        reason: 'operation_failed',
        outcome: failure,
      };
    }

    const missingReceipt = input.ledger?.latestHighRiskWithoutReceipt();
    if (missingReceipt) {
      if ((input.evidenceRequestCount ?? 0) < 1) {
        return {
          action: 'continue',
          status: 'paused',
          reason: 'high_risk_receipt_missing',
          outcome: missingReceipt,
          prompt: buildEvidencePrompt(missingReceipt),
        };
      }
      return {
        action: 'pause',
        status: 'paused',
        reason: 'high_risk_receipt_missing',
        outcome: missingReceipt,
      };
    }

    if (input.ledger?.hasCompletedMutation() && !input.ledger.hasIndependentReceipt()) {
      return {
        action: 'complete',
        status: 'completed_unverified',
        reason: 'settled_without_independent_receipt',
      };
    }

    return {
      action: 'complete',
      status: 'completed',
      reason: 'settled',
    };
  }
}

export function buildCompletionGatePrompt(decision: CompletionGateDecision): string | null {
  if (decision.prompt) return decision.prompt;
  if (decision.reason === 'explicit_condition_pending') {
    return '[System / Completion Gate] An explicit user completion condition is still pending. Satisfy that condition before finishing.';
  }
  return null;
}

function buildFailurePrompt(outcome: OperationOutcome): string {
  return [
    '[System / Completion Gate] The latest relevant operation failed.',
    `Operation: ${outcome.toolName}`,
    outcome.error ? `Error: ${outcome.error}` : '',
    'Try one materially different corrective step if practical. Otherwise stop and report the failure plainly.',
    'Do not repeat the identical failed action.',
  ].filter(Boolean).join('\n');
}

function buildEvidencePrompt(outcome: OperationOutcome): string {
  return [
    '[System / Completion Gate] A high-risk operation completed without a usable result receipt.',
    `Operation: ${outcome.toolName}`,
    'Use one targeted observation to confirm the resulting state if available.',
    'Do not repeat the operation itself or run unrelated checks.',
  ].join('\n');
}
