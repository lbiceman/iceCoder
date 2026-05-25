import { describe, expect, it } from 'vitest';

import {
  formatBudgetExhaustionReason,
  RecoveryBudgetManager,
} from '../../src/harness/supervisor/recovery-budget-manager.js';
import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';

const params = defaultSupervisorConfig().params;

describe('RecoveryBudgetManager - lifecycle', () => {
  it('is inactive before beginTakeover and evaluate returns not exhausted', () => {
    const mgr = new RecoveryBudgetManager(params);
    expect(mgr.isActive()).toBe(false);
    expect(mgr.evaluate()).toEqual({ exhausted: false });
  });

  it('beginTakeover seeds adaptive budget by default', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(2, 'adaptive');

    expect(mgr.isActive()).toBe(true);
    const snap = mgr.snapshot();
    // adaptiveTakeover defaults: maxRecoveryRounds=3, recoveryTokenRatio=0.25, maxRecoveryRetries=2
    expect(snap.maxRounds).toBe(3);
    expect(snap.maxTokenRatio).toBeCloseTo(0.25, 5);
    expect(snap.maxRetries).toBe(2);
    expect(snap.startRound).toBe(2);
    expect(snap.roundsUsed).toBe(0);
  });

  it('strict mode uses strict params (maxRecoveryRounds=5, ratio=0.30)', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'strict');
    const snap = mgr.snapshot();
    expect(snap.maxRounds).toBe(5);
    expect(snap.maxTokenRatio).toBeCloseTo(0.3, 5);
  });

  it('reset clears active flag and counters', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    mgr.tickRound(1);
    mgr.recordTokenUsage(100, 200);
    mgr.recordRetry('edit_file:foo');
    mgr.reset();
    expect(mgr.isActive()).toBe(false);
    expect(mgr.evaluate()).toEqual({ exhausted: false });
  });
});

describe('RecoveryBudgetManager - round budget', () => {
  it('tickRound is idempotent within the same round', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    mgr.tickRound(1);
    mgr.tickRound(1);
    mgr.tickRound(1);
    expect(mgr.snapshot().roundsUsed).toBe(1);
  });

  it('exhausts when roundsUsed exceeds maxRecoveryRounds', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    // adaptiveTakeover.maxRecoveryRounds = 3
    mgr.tickRound(1);
    mgr.tickRound(2);
    mgr.tickRound(3);
    expect(mgr.evaluate().exhausted).toBe(false);
    mgr.tickRound(4);
    const result = mgr.evaluate();
    expect(result.exhausted).toBe(true);
    expect(result.reason).toBe('max_recovery_rounds');
    expect(result.detail?.roundsUsed).toBe(4);
  });

  it('tickRound is no-op when budget is inactive', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.tickRound(1);
    expect(mgr.snapshot().roundsUsed).toBe(0);
  });

  it('tickRound(effective=false) does not increment roundsUsed', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    mgr.tickRound(1, true);
    mgr.tickRound(2, false);
    mgr.tickRound(3, false);
    expect(mgr.snapshot().roundsUsed).toBe(1);
  });
});

describe('RecoveryBudgetManager - token ratio', () => {
  it('exhausts when token ratio exceeds recoveryTokenRatio', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    // adaptiveTakeover.recoveryTokenRatio = 0.25 → 26% triggers
    mgr.recordTokenUsage(260, 1000);
    const result = mgr.evaluate();
    expect(result.exhausted).toBe(true);
    expect(result.reason).toBe('recovery_token_ratio');
    expect(result.detail?.tokenRatioUsed).toBeCloseTo(0.26, 5);
  });

  it('safely ignores zero/negative totals', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    mgr.recordTokenUsage(100, 0);
    mgr.recordTokenUsage(100, -1);
    expect(mgr.evaluate().exhausted).toBe(false);
  });

  it('keeps peak ratio (monotonic non-decreasing)', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    mgr.recordTokenUsage(200, 1000);
    mgr.recordTokenUsage(50, 1000);
    expect(mgr.snapshot().tokenRatioUsed).toBeCloseTo(0.2, 5);
  });
});

describe('RecoveryBudgetManager - retries', () => {
  it('exhausts when retry count exceeds maxRecoveryRetries', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    // adaptiveTakeover.maxRecoveryRetries = 2 → 3rd retry triggers
    mgr.recordRetry('edit_file:foo');
    mgr.recordRetry('edit_file:foo');
    expect(mgr.evaluate().exhausted).toBe(false);
    mgr.recordRetry('edit_file:foo');
    const result = mgr.evaluate();
    expect(result.exhausted).toBe(true);
    expect(result.reason).toBe('max_recovery_retries');
    expect(result.detail?.maxRetryCount).toBe(3);
  });

  it('different signatures keep independent counters', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    mgr.recordRetry('a');
    mgr.recordRetry('a');
    mgr.recordRetry('b');
    expect(mgr.snapshot().maxRetryCount).toBe(2);
  });

  it('empty signature is ignored', () => {
    const mgr = new RecoveryBudgetManager(params);
    mgr.beginTakeover(1, 'adaptive');
    mgr.recordRetry('');
    expect(mgr.snapshot().maxRetryCount).toBe(0);
  });
});

describe('formatBudgetExhaustionReason', () => {
  it('maps reason codes to budget_exhausted:* labels', () => {
    expect(formatBudgetExhaustionReason('max_recovery_rounds')).toBe('budget_exhausted:rounds');
    expect(formatBudgetExhaustionReason('recovery_token_ratio')).toBe('budget_exhausted:tokens');
    expect(formatBudgetExhaustionReason('max_recovery_retries')).toBe('budget_exhausted:retries');
  });
});
