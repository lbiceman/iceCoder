import { describe, expect, it } from 'vitest';

import {
  evaluateCompletionHardState,
  type CompletionHardStateDecision,
} from '../../src/harness/completion-state.js';
import { STOP_VERIFICATION_TOOL_CALL_PREFIX } from '../../src/harness/harness-stop-verification.js';
import {
  OperationOutcomeLedger,
  type OperationOutcome,
} from '../../src/harness/operation-outcome.js';

function outcome(
  overrides: Partial<OperationOutcome> = {},
): OperationOutcome {
  return {
    toolCallId: 'tool-1',
    toolName: 'run_command',
    status: 'completed',
    effect: 'execute',
    risk: 'low',
    disposition: 'executed',
    scope: 'command:one',
    at: 1,
    ...overrides,
  };
}

function decide(...outcomes: OperationOutcome[]): CompletionHardStateDecision | null {
  const ledger = new OperationOutcomeLedger();
  for (const item of outcomes) ledger.record(item);
  return evaluateCompletionHardState(ledger);
}

describe('evaluateCompletionHardState', () => {
  it.each(['pending', 'awaiting_approval'] as const)(
    'pauses for %s operations',
    status => {
      expect(decide(outcome({ status }))).toMatchObject({
        status: 'paused',
        reason: 'operation_pending',
      });
    },
  );

  it.each(['user_denied', 'policy_block'] as const)(
    'pauses for %s without requesting a retry',
    disposition => {
      expect(decide(outcome({
        status: 'failed',
        effect: 'external_change',
        risk: 'high',
        disposition,
      }))).toMatchObject({
        status: 'paused',
        reason: disposition === 'user_denied'
          ? 'operation_user_denied'
          : 'operation_policy_blocked',
      });
    },
  );

  it.each(['local_change', 'external_change'] as const)(
    'fails an unresolved %s write failure',
    effect => {
      expect(decide(outcome({
        status: 'failed',
        effect,
        disposition: 'execution_fail',
      }))).toMatchObject({
        status: 'failed',
        reason: 'operation_write_failed',
      });
    },
  );

  it('fails a high-risk execute failure but ignores ordinary probes', () => {
    expect(decide(outcome({
      status: 'failed',
      effect: 'execute',
      risk: 'high',
      disposition: 'execution_fail',
    }))).toMatchObject({
      status: 'failed',
      reason: 'operation_write_failed',
    });

    expect(decide(outcome({
      status: 'failed',
      effect: 'observe',
      disposition: 'execution_fail',
      error: 'git diff exited 129',
    }))).toBeNull();
    expect(decide(outcome({
      status: 'failed',
      effect: 'execute',
      risk: 'low',
      disposition: 'execution_fail',
      error: 'git diff exited 129',
    }))).toBeNull();
  });

  it('uses terminal failed status for a write even when the executor reported executed disposition', () => {
    expect(decide(outcome({
      status: 'failed',
      effect: 'local_change',
      disposition: 'executed',
    }))).toMatchObject({
      status: 'failed',
      reason: 'operation_write_failed',
    });
  });

  it('pauses when a high-risk success has no usable receipt', () => {
    expect(decide(outcome({
      effect: 'external_change',
      risk: 'high',
      receipt: { target: 'production' },
    }))).toMatchObject({
      status: 'paused',
      reason: 'high_risk_receipt_missing',
    });

    expect(decide(outcome({
      effect: 'external_change',
      risk: 'high',
      receipt: { operationId: 'deploy-1' },
    }))).toBeNull();
  });

  it('ignores failures and denials recorded before this run started', () => {
    const ledger = new OperationOutcomeLedger();
    ledger.record(outcome({
      toolCallId: 'old-write',
      status: 'failed',
      effect: 'local_change',
      disposition: 'execution_fail',
      scope: 'target:src/a.ts',
      at: 100,
    }));
    ledger.record(outcome({
      toolCallId: 'old-deny',
      status: 'failed',
      effect: 'local_change',
      disposition: 'user_denied',
      scope: 'target:src/b.ts',
      at: 110,
    }));
    expect(evaluateCompletionHardState(ledger)).not.toBeNull();
    expect(evaluateCompletionHardState(ledger, { since: 200 })).toBeNull();

    ledger.record(outcome({ toolCallId: 'old-bg', status: 'pending', scope: 'operation:bg_1', at: 120 }));
    expect(evaluateCompletionHardState(ledger, { since: 200 })).toMatchObject({
      reason: 'operation_pending',
    });
  });

  it('a later successful change on another target resolves an earlier failure', () => {
    const failedWrite = outcome({
      toolCallId: 'w1',
      status: 'failed',
      effect: 'local_change',
      disposition: 'execution_fail',
      scope: 'target:src/a.ts',
      at: 1,
    });
    expect(decide(failedWrite, outcome({
      toolCallId: 'w2',
      effect: 'local_change',
      scope: 'target:src/b.ts',
      receipt: { summary: 'written' },
      at: 2,
    }))).toBeNull();

    // 同一批里先后完成的成功不能掩盖失败。
    expect(decide(failedWrite, outcome({
      toolCallId: 'w2',
      effect: 'local_change',
      scope: 'target:src/b.ts',
      at: 1,
    }))).toMatchObject({ reason: 'operation_write_failed' });

    // 只读成功不算进展。
    expect(decide(failedWrite, outcome({
      toolCallId: 'r1',
      effect: 'observe',
      scope: 'target:src/c.ts',
      at: 2,
    }))).toMatchObject({ reason: 'operation_write_failed' });
  });

  it('ignores stop-verification synthetic calls; the verification path owns their result', () => {
    expect(decide(outcome({
      toolCallId: `${STOP_VERIFICATION_TOOL_CALL_PREFIX}plan:0:run:1`,
      status: 'failed',
      effect: 'local_change',
      disposition: 'execution_fail',
    }))).toBeNull();
  });

  it('uses only the latest unresolved outcome per scope', () => {
    expect(decide(
      outcome({
        toolCallId: 'failed',
        status: 'failed',
        effect: 'local_change',
        disposition: 'execution_fail',
        at: 1,
      }),
      outcome({
        toolCallId: 'fixed',
        status: 'completed',
        effect: 'local_change',
        receipt: { summary: 'updated' },
        at: 2,
      }),
    )).toBeNull();
  });
});
