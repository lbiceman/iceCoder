import { describe, expect, it } from 'vitest';

import type { CompletionCondition } from '../../src/harness/completion-condition.js';
import { CompletionGate } from '../../src/harness/completion-gate.js';
import {
  normalizeOperationOutcome,
  OperationOutcomeLedger,
  type OperationOutcome,
} from '../../src/harness/operation-outcome.js';

function ledgerWith(...outcomes: OperationOutcome[]): OperationOutcomeLedger {
  const ledger = new OperationOutcomeLedger();
  for (const outcome of outcomes) ledger.record(outcome);
  return ledger;
}

function requiredCondition(
  status: CompletionCondition['status'],
  evidenceRefs: string[] = [],
): CompletionCondition {
  return {
    id: 'required:1',
    label: 'Required condition',
    required: true,
    status,
    source: 'user',
    sourceRef: 'user:1',
    evidenceRefs,
  };
}

describe('CompletionGate', () => {
  const gate = new CompletionGate();

  it('completes ready no-tool and read-only work immediately', () => {
    expect(gate.evaluate({ answerReady: true }).action).toBe('complete');

    const ledger = ledgerWith(normalizeOperationOutcome(
      { id: 'r1', name: 'read_file', arguments: { path: 'a.txt' } },
      { success: true, output: 'content' },
    ));
    expect(gate.evaluate({ ledger, answerReady: true })).toMatchObject({
      action: 'complete',
      status: 'completed',
    });
  });

  it('accepts one successful low-risk operation without forcing another round', () => {
    const ledger = ledgerWith({
      toolCallId: 'x1',
      toolName: 'operation',
      status: 'completed',
      effect: 'local_change',
      risk: 'low',
      disposition: 'executed',
      scope: 'target:x1',
      at: 1,
    });

    expect(gate.evaluate({ ledger, answerReady: true })).toMatchObject({
      action: 'complete',
      status: 'completed_unverified',
    });
  });

  it('pauses while an operation or approval is pending', () => {
    const ledger = ledgerWith({
      toolCallId: 'p1',
      toolName: 'operation',
      status: 'pending',
      effect: 'execute',
      risk: 'low',
      disposition: 'executed',
      scope: 'operation:p1',
      at: 1,
    });

    expect(gate.evaluate({ ledger, answerReady: true })).toMatchObject({
      action: 'pause',
      reason: 'operation_pending',
    });
  });

  it('offers one corrective turn for the same failure snapshot, then fails', () => {
    const ledger = ledgerWith({
      toolCallId: 'f1',
      toolName: 'operation',
      status: 'failed',
      effect: 'execute',
      risk: 'low',
      disposition: 'execution_fail',
      scope: 'target:1',
      error: 'failed',
      at: 1,
    });

    const first = gate.evaluate({ ledger, answerReady: true });
    expect(first.action).toBe('continue');
    expect(gate.evaluate({
      ledger,
      answerReady: true,
      continuationCount: 1,
      previousBlockingSignature: first.blockingSignature,
    })).toMatchObject({ action: 'fail', status: 'failed' });
  });

  it('does not retry a user-denied action', () => {
    const ledger = ledgerWith({
      toolCallId: 'd1',
      toolName: 'operation',
      status: 'failed',
      effect: 'external_change',
      risk: 'high',
      disposition: 'user_denied',
      scope: 'target:1',
      at: 1,
    });

    expect(gate.evaluate({ ledger, answerReady: true })).toMatchObject({
      action: 'pause',
      status: 'paused',
    });
  });

  it('pauses an operation blocked by policy', () => {
    const ledger = ledgerWith({
      toolCallId: 'b1',
      toolName: 'operation',
      status: 'failed',
      effect: 'execute',
      risk: 'low',
      disposition: 'policy_block',
      scope: 'target:1',
      at: 1,
    });

    expect(gate.evaluate({ ledger, answerReady: true })).toMatchObject({
      action: 'pause',
      status: 'paused',
      reason: 'operation_failed',
    });
  });

  it('requests high-risk evidence at most once per unchanged snapshot', () => {
    const ledger = ledgerWith({
      toolCallId: 'h1',
      toolName: 'operation',
      status: 'completed',
      effect: 'external_change',
      risk: 'high',
      disposition: 'executed',
      scope: 'target:1',
      at: 1,
    });

    const first = gate.evaluate({ ledger, answerReady: true });
    expect(first.action).toBe('continue');
    expect(gate.evaluate({
      ledger,
      answerReady: true,
      continuationCount: 1,
      previousBlockingSignature: first.blockingSignature,
    })).toMatchObject({ action: 'pause', reason: 'high_risk_receipt_missing' });
  });

  it('requires real evidence before satisfying a required condition', () => {
    const outcome = normalizeOperationOutcome(
      { id: 'e1', name: 'run_command', arguments: { command: 'check' } },
      { success: true, output: JSON.stringify({ status: 'completed', exitCode: 0 }) },
    );
    const ledger = ledgerWith(outcome);

    expect(gate.evaluate({
      ledger,
      answerReady: true,
      conditions: [requiredCondition('satisfied')],
    }).reason).toBe('condition_pending');
    expect(gate.evaluate({
      ledger,
      answerReady: true,
      conditions: [requiredCondition('satisfied', ['e1'])],
    }).action).toBe('complete');
  });

  it('pauses an unverifiable required condition', () => {
    expect(gate.evaluate({
      answerReady: true,
      conditions: [requiredCondition('unverifiable')],
    })).toMatchObject({ action: 'pause', reason: 'condition_unverifiable' });
  });

  it('does not let unrelated success hide a failure in another scope', () => {
    const ledger = ledgerWith(
      {
        toolCallId: 'f1',
        toolName: 'operation',
        status: 'failed',
        effect: 'local_change',
        risk: 'low',
        disposition: 'execution_fail',
        scope: 'target:failed',
        at: 1,
      },
      {
        toolCallId: 'r1',
        toolName: 'read_file',
        status: 'completed',
        effect: 'observe',
        risk: 'low',
        disposition: 'executed',
        scope: 'target:other',
        at: 2,
      },
    );

    expect(gate.evaluate({ ledger, answerReady: true }).reason).toBe('operation_failed');
  });

  it('does not let answerReady bypass hard state', () => {
    expect(gate.evaluate({
      answerReady: true,
      conditions: [requiredCondition('pending')],
    })).toMatchObject({ action: 'continue', reason: 'condition_pending' });
  });
});
