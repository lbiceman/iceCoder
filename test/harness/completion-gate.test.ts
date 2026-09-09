import { describe, expect, it } from 'vitest';

import { CompletionGate } from '../../src/harness/completion-gate.js';
import {
  normalizeOperationOutcome,
  OperationOutcomeLedger,
  type OperationOutcome,
} from '../../src/harness/operation-outcome.js';

function ledgerWith(outcome: OperationOutcome): OperationOutcomeLedger {
  const ledger = new OperationOutcomeLedger();
  ledger.record(outcome);
  return ledger;
}

describe('CompletionGate', () => {
  const gate = new CompletionGate();

  it('completes read-only and no-tool work immediately', () => {
    expect(gate.evaluate({}).action).toBe('complete');

    const ledger = ledgerWith(normalizeOperationOutcome(
      { id: 'r1', name: 'read_file', arguments: { path: 'a.txt' } },
      { success: true, output: 'content' },
    ));
    expect(gate.evaluate({ ledger })).toMatchObject({
      action: 'complete',
      status: 'completed',
    });
  });

  it('accepts one successful low-risk operation without an extra round', () => {
    const ledger = ledgerWith({
      toolCallId: 'x1',
      toolName: 'computer_action',
      status: 'completed',
      effect: 'local_change',
      risk: 'low',
      disposition: 'executed',
      scope: 'computer_action:x1',
      at: 1,
    });

    expect(gate.evaluate({ ledger })).toMatchObject({
      action: 'complete',
      status: 'completed_unverified',
    });
  });

  it('pauses while work or approval is pending', () => {
    const ledger = ledgerWith({
      toolCallId: 'p1',
      toolName: 'background_task',
      status: 'pending',
      effect: 'execute',
      risk: 'low',
      disposition: 'executed',
      scope: 'operation:p1',
      at: 1,
    });

    expect(gate.evaluate({ ledger })).toMatchObject({
      action: 'pause',
      reason: 'operation_pending',
    });
  });

  it('offers one corrective turn after failure, then terminates as failed', () => {
    const ledger = ledgerWith({
      toolCallId: 'f1',
      toolName: 'shell',
      status: 'failed',
      effect: 'execute',
      risk: 'low',
      disposition: 'execution_fail',
      scope: 'shell:task',
      error: 'exit 1',
      at: 1,
    });

    expect(gate.evaluate({ ledger, recoveryCount: 0 }).action).toBe('continue');
    expect(gate.evaluate({ ledger, recoveryCount: 1 })).toMatchObject({
      action: 'fail',
      status: 'failed',
    });
  });

  it('does not retry a user-denied action', () => {
    const ledger = ledgerWith({
      toolCallId: 'd1',
      toolName: 'external_action',
      status: 'failed',
      effect: 'external_change',
      risk: 'high',
      disposition: 'user_denied',
      scope: 'external_action:d1',
      at: 1,
    });

    expect(gate.evaluate({ ledger })).toMatchObject({
      action: 'pause',
      status: 'paused',
    });
  });

  it('requests high-risk evidence at most once', () => {
    const ledger = ledgerWith({
      toolCallId: 'h1',
      toolName: 'destructive_action',
      status: 'completed',
      effect: 'external_change',
      risk: 'high',
      disposition: 'executed',
      scope: 'destructive_action:h1',
      at: 1,
    });

    expect(gate.evaluate({ ledger, evidenceRequestCount: 0 }).action).toBe('continue');
    expect(gate.evaluate({ ledger, evidenceRequestCount: 1 })).toMatchObject({
      action: 'pause',
      reason: 'high_risk_receipt_missing',
    });
  });

  it('never waives an explicit pending condition', () => {
    expect(gate.evaluate({ explicitConditionsPending: true })).toMatchObject({
      action: 'continue',
      reason: 'explicit_condition_pending',
    });
  });
});
