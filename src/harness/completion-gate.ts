import type { OperationOutcome, OperationOutcomeLedger } from './operation-outcome.js';
import type { CompletionCondition } from './completion-condition.js';

export type CompletionStatus =
  | 'completed'
  | 'completed_unverified'
  | 'paused'
  | 'failed'
  | 'interrupted';

export type CompletionGateAction = 'complete' | 'continue' | 'pause' | 'fail';
export type CompletionGateReason =
  | 'condition_pending'
  | 'condition_failed'
  | 'condition_unverifiable'
  | 'operation_pending'
  | 'operation_failed'
  | 'high_risk_receipt_missing'
  | 'answer_not_ready'
  | 'settled'
  | 'settled_without_independent_receipt';

export interface CompletionGateInput {
  ledger?: OperationOutcomeLedger;
  conditions?: readonly CompletionCondition[];
  answerReady?: boolean;
  continuationCount?: number;
  previousBlockingSignature?: string;
  maxContinuations?: number;
}

export interface CompletionGateDecision {
  action: CompletionGateAction;
  status: CompletionStatus;
  reason: CompletionGateReason;
  prompt?: string;
  outcome?: OperationOutcome;
  condition?: CompletionCondition;
  blockingSignature?: string;
}

/**
 * 与语言和工具名无关的收尾判定。它只消费标准化操作状态；
 * 测试、截图、文件读取等是否值得执行，交给模型的软提示判断。
 */
export class CompletionGate {
  evaluate(input: CompletionGateInput): CompletionGateDecision {
    const blockingCondition = findBlockingCondition(input.conditions ?? [], input.ledger);
    if (blockingCondition) {
      const reason = blockingCondition.status === 'failed'
        ? 'condition_failed'
        : blockingCondition.status === 'unverifiable'
          ? 'condition_unverifiable'
          : 'condition_pending';
      const blockingSignature = `condition:${blockingCondition.id}:${blockingCondition.status}`;
      if (reason === 'condition_unverifiable') {
        return {
          action: 'pause',
          status: 'paused',
          reason,
          condition: blockingCondition,
          blockingSignature,
        };
      }
      if (canContinue(input, blockingSignature)) {
        const decision: CompletionGateDecision = {
          action: 'continue',
          status: reason === 'condition_failed' ? 'failed' : 'paused',
          reason,
          condition: blockingCondition,
          blockingSignature,
        };
        decision.prompt = buildConditionPrompt(input.conditions ?? [], reason);
        return decision;
      }
      return {
        action: reason === 'condition_failed' ? 'fail' : 'pause',
        status: reason === 'condition_failed' ? 'failed' : 'paused',
        reason,
        condition: blockingCondition,
        blockingSignature,
      };
    }

    const pending = input.ledger?.latestPending();
    if (pending) {
      return {
        action: 'pause',
        status: 'paused',
        reason: 'operation_pending',
        outcome: pending,
        blockingSignature: `pending:${pending.scope}`,
      };
    }

    const failure = input.ledger?.latestUnresolvedFailure();
    if (failure) {
      const blockingSignature = `failure:${failure.scope}`;
      const cannotRetry = failure.disposition === 'user_denied'
        || failure.disposition === 'policy_block';
      if (!cannotRetry && canContinue(input, blockingSignature)) {
        return {
          action: 'continue',
          status: 'failed',
          reason: 'operation_failed',
          outcome: failure,
          prompt: buildFailurePrompt(failure),
          blockingSignature,
        };
      }
      return {
        action: cannotRetry ? 'pause' : 'fail',
        status: cannotRetry ? 'paused' : 'failed',
        reason: 'operation_failed',
        outcome: failure,
        blockingSignature,
      };
    }

    const missingReceipt = input.ledger?.latestHighRiskWithoutReceipt();
    if (missingReceipt) {
      const blockingSignature = `evidence:${missingReceipt.scope}`;
      if (canContinue(input, blockingSignature)) {
        return {
          action: 'continue',
          status: 'paused',
          reason: 'high_risk_receipt_missing',
          outcome: missingReceipt,
          prompt: buildEvidencePrompt(missingReceipt),
          blockingSignature,
        };
      }
      return {
        action: 'pause',
        status: 'paused',
        reason: 'high_risk_receipt_missing',
        outcome: missingReceipt,
        blockingSignature,
      };
    }

    if (input.answerReady === false) {
      const blockingSignature = 'answer:not_ready';
      return canContinue(input, blockingSignature)
        ? {
            action: 'continue',
            status: 'paused',
            reason: 'answer_not_ready',
            prompt: '[System / Completion Gate] The requested result is not ready. Continue the current task without expanding its scope.',
            blockingSignature,
          }
        : {
            action: 'pause',
            status: 'paused',
            reason: 'answer_not_ready',
            blockingSignature,
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
  return null;
}

function canContinue(input: CompletionGateInput, blockingSignature: string): boolean {
  const count = input.continuationCount ?? 0;
  const max = input.maxContinuations ?? 3;
  return count < max && input.previousBlockingSignature !== blockingSignature;
}

function findBlockingCondition(
  conditions: readonly CompletionCondition[],
  ledger: OperationOutcomeLedger | undefined,
): CompletionCondition | undefined {
  return conditions.find(condition => {
    if (!condition.required) return false;
    if (condition.status !== 'satisfied') return true;
    if (condition.evidenceRefs.length === 0) return true;
    return !condition.evidenceRefs.some(reference => {
      const outcome = ledger?.getByToolCallId(reference);
      return outcome?.status === 'completed';
    });
  });
}

function buildConditionPrompt(
  conditions: readonly CompletionCondition[],
  reason: 'condition_pending' | 'condition_failed',
): string {
  const pending = conditions.filter(condition =>
    condition.required && condition.status !== 'satisfied',
  );
  return [
    '[System / Completion Gate] Required completion conditions are not settled.',
    ...pending.map(condition => `- ${condition.label}: ${condition.status}`),
    reason === 'condition_failed'
      ? 'Try one materially different corrective step if practical.'
      : 'Satisfy all pending conditions together before finishing.',
    'Do not repeat an unchanged action or perform unrelated checks.',
  ].join('\n');
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
