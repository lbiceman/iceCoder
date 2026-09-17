import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHECK_FAILURE_STREAK_REBUILD,
  emptyCheckFailureStreak,
  findCheckFailureStreakRebuild,
  markCheckStreakRebuild,
  recordCheckCommandOutcome,
} from '../../src/harness/check-failure-streak.js';
import { tryInjectRebuildEscalation } from '../../src/harness/harness-rebuild-inject.js';
import { emptyHarnessPolicyStats } from '../../src/harness/harness-policy-stats.js';
import { BranchBudgetTracker } from '../../src/harness/branch-budget.js';
import type { HarnessRunState } from '../../src/harness/harness-run-state.js';
import { VerificationOutputBuffer } from '../../src/harness/verification-output-buffer.js';
import {
  normalizeAcceptanceCommandKey,
  type RunCommandResultClassification,
} from '../../src/harness/run-command-result.js';
import type { UnifiedMessage } from '../../src/llm/types.js';

const OPAQUE_CI = './scripts/ci.sh';
const OTHER_CMD = 'pytest -q';

function fgFail(command: string): RunCommandResultClassification {
  return { kind: 'foreground', command, foregroundSuccess: false };
}

function fgOk(command: string): RunCommandResultClassification {
  return { kind: 'foreground', command, foregroundSuccess: true };
}

function bgStart(command: string): RunCommandResultClassification {
  return { kind: 'background_start', command };
}

function bgRunning(command: string): RunCommandResultClassification {
  return { kind: 'background_running', command };
}

function bgFailed(command: string): RunCommandResultClassification {
  return { kind: 'background_failed', command, exitCode: 1, statusLabel: 'failed' };
}

function failN(state: ReturnType<typeof emptyCheckFailureStreak>, command: string, n: number): void {
  for (let i = 0; i < n; i++) {
    recordCheckCommandOutcome(state, fgFail(command));
  }
}

describe('check-failure-streak', () => {
  it('does not trigger before the 6th terminal failure', () => {
    const state = emptyCheckFailureStreak();
    failN(state, OPAQUE_CI, CHECK_FAILURE_STREAK_REBUILD - 1);
    expect(findCheckFailureStreakRebuild(state)).toBeNull();
  });

  it('triggers Rebuild on the 6th failure of the same opaque command', () => {
    const state = emptyCheckFailureStreak();
    failN(state, OPAQUE_CI, CHECK_FAILURE_STREAK_REBUILD);
    const pending = findCheckFailureStreakRebuild(state);
    expect(pending?.failCount).toBe(6);
    expect(pending?.label).toBe(OPAQUE_CI);
  });

  it('does not reset the streak when writes happen between failures', () => {
    const state = emptyCheckFailureStreak();
    failN(state, OPAQUE_CI, 3);
    // write_file / edit_file never call recordCheckCommandOutcome
    failN(state, OPAQUE_CI, 3);
    expect(findCheckFailureStreakRebuild(state)?.failCount).toBe(6);
  });

  it('clears the key after a terminal success', () => {
    const state = emptyCheckFailureStreak();
    failN(state, OPAQUE_CI, 5);
    recordCheckCommandOutcome(state, fgOk(OPAQUE_CI));
    failN(state, OPAQUE_CI, 5);
    expect(findCheckFailureStreakRebuild(state)).toBeNull();
    recordCheckCommandOutcome(state, fgFail(OPAQUE_CI));
    expect(findCheckFailureStreakRebuild(state)?.failCount).toBe(6);
  });

  it('treats ./scripts/ci.sh and redirected forms as the same key', () => {
    const state = emptyCheckFailureStreak();
    failN(state, OPAQUE_CI, 3);
    failN(state, './scripts/ci.sh 2>&1', 3);
    expect(findCheckFailureStreakRebuild(state)?.failCount).toBe(6);
  });

  it('keeps independent keys from affecting each other', () => {
    const state = emptyCheckFailureStreak();
    failN(state, OPAQUE_CI, 6);
    failN(state, OTHER_CMD, 2);
    const pending = findCheckFailureStreakRebuild(state);
    expect(pending?.label).toBe(OPAQUE_CI);
    expect(state.entries[normalizeAcceptanceCommandKey(OTHER_CMD)]?.failCount).toBe(2);
  });

  it('ignores background start and running', () => {
    const state = emptyCheckFailureStreak();
    for (let i = 0; i < 8; i++) {
      expect(recordCheckCommandOutcome(state, bgStart(OPAQUE_CI))).toBeNull();
      expect(recordCheckCommandOutcome(state, bgRunning(OPAQUE_CI))).toBeNull();
    }
    expect(findCheckFailureStreakRebuild(state)).toBeNull();
  });

  it('counts background_failed as a terminal failure', () => {
    const state = emptyCheckFailureStreak();
    for (let i = 0; i < CHECK_FAILURE_STREAK_REBUILD; i++) {
      recordCheckCommandOutcome(state, bgFailed(OPAQUE_CI));
    }
    expect(findCheckFailureStreakRebuild(state)?.failCount).toBe(6);
  });

  it('re-triggers every 6 failures after a successful Rebuild mark (6 / 12)', () => {
    const state = emptyCheckFailureStreak();
    failN(state, OPAQUE_CI, 6);
    const first = findCheckFailureStreakRebuild(state);
    expect(first).not.toBeNull();
    markCheckStreakRebuild(state, first!.key);
    expect(findCheckFailureStreakRebuild(state)).toBeNull();

    failN(state, OPAQUE_CI, 5);
    expect(findCheckFailureStreakRebuild(state)).toBeNull();
    failN(state, OPAQUE_CI, 1);
    expect(findCheckFailureStreakRebuild(state)?.failCount).toBe(12);
  });
});

describe('check-failure-streak rebuild injection', () => {
  it('injects Rebuild Escalation without circuit-breaker or ask_user wording', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-streak-'));
    const msgs: UnifiedMessage[] = [];
    const state = {
      rebuildEscalationInjections: 0,
      rebuildEscalationInjectedThisRound: false,
      branchBudget: undefined,
      verificationOutputBuffer: new VerificationOutputBuffer(),
      harnessPolicyStats: emptyHarnessPolicyStats(),
    } as HarnessRunState;

    const injected = tryInjectRebuildEscalation(
      { workspaceRoot: root },
      state,
      msgs,
      6,
      'check_failure_streak',
      { stuckCommand: OPAQUE_CI },
    );

    expect(injected).toBe(true);
    expect(state.rebuildEscalationInjections).toBe(1);
    const content = String(msgs[0]?.content ?? '');
    expect(content).toMatch(/same verification command/);
    expect(content).toContain(OPAQUE_CI);
    expect(content).toMatch(/writes in between do not reset this count/);
    expect(content).toMatch(/Platform continues/);
    expect(content).not.toMatch(/circuit_breaker|ask_user|consecutive rounds of tool calls have all failed/);
  });

  it('grants command retry bypass from stuckCommand when history has no verification command', () => {
    const root = mkdtempSync(join(tmpdir(), 'ice-streak-bypass-'));
    const budget = new BranchBudgetTracker({ commandRetryMax: 2 });
    budget.recordFailedCommandAttempt(OPAQUE_CI);
    budget.recordFailedCommandAttempt(OPAQUE_CI);
    expect(budget.wouldBlockCommandRetry(OPAQUE_CI)).toBe(true);

    const msgs: UnifiedMessage[] = [];
    const state = {
      rebuildEscalationInjections: 0,
      rebuildEscalationInjectedThisRound: false,
      branchBudget: budget,
      verificationOutputBuffer: new VerificationOutputBuffer(),
      harnessPolicyStats: emptyHarnessPolicyStats(),
    } as HarnessRunState;

    expect(tryInjectRebuildEscalation(
      { workspaceRoot: root },
      state,
      msgs,
      6,
      'check_failure_streak',
      { stuckCommand: OPAQUE_CI },
    )).toBe(true);

    expect(budget.hasCommandRetryBypass(OPAQUE_CI)).toBe(true);
    expect(String(msgs[0]?.content ?? '')).toMatch(/run_command.*\.\/scripts\/ci\.sh/);
    expect(String(msgs[0]?.content ?? '')).toMatch(/one retry of `\.\/scripts\/ci\.sh`/);
  });
});
