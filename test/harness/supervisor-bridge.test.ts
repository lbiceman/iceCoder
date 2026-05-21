import { describe, expect, it } from 'vitest';

import type { UnifiedMessage } from '../../src/llm/types.js';
import { resolveSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import { createSupervisorRuntimeBridge } from '../../src/harness/supervisor/supervisor-bridge.js';

describe('SupervisorRuntimeBridge - L2-1', () => {
  it('is inactive when ICE_SUPERVISOR_MODE=off and writes no timeline events', () => {
    const config = resolveSupervisorConfig({ mode: 'off' }, { ICE_SUPERVISOR_MODE: 'off' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    expect(bridge.isActive()).toBe(false);

    bridge.recordExecutionModeSwitch({
      round: 1,
      from: 'free',
      to: 'forced',
      reason: 'pending_steps',
    });
    bridge.recordShadowWouldTakeover({
      round: 1,
      phase: 'free',
      reason: 'would takeover',
    });

    expect(bridge.eventTimeline.getRecentEvents()).toEqual([]);
  });

  it('records execution mode switch events when supervisor is active', () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    bridge.recordExecutionModeSwitch({
      round: 3,
      from: 'free',
      to: 'forced',
      reason: 'multi_write',
    });

    expect(bridge.eventTimeline.getRecentEvents()).toEqual([
      expect.objectContaining({
        round: 3,
        mode: 'adaptive',
        event: 'switch',
        reason: 'free->forced: multi_write',
      }),
    ]);
  });

  it('records shadow_diagnostic without changing phase semantics via applyDecision', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', shadow: true },
      { ICE_SUPERVISOR_MODE: 'adaptive', ICE_SUPERVISOR_SHADOW: '1' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const messages: UnifiedMessage[] = [];

    const decision = bridge.applyDecision(
      {
        action: 'takeover',
        reason: 'tool_repeat_fail',
        signals: [{ type: 'tool_repeat_fail', count: 3 }],
      },
      'free',
      2,
    );

    expect(decision).toEqual({ action: 'continue' });
    expect(bridge.eventTimeline.getRecentEvents()).toEqual([
      expect.objectContaining({
        round: 2,
        event: 'shadow_diagnostic',
        reason: 'tool_repeat_fail',
        payload: { signals: [{ type: 'tool_repeat_fail', count: 3 }] },
      }),
    ]);

    bridge.recordShadowWouldTakeover({
      round: 2,
      phase: 'free',
      reason: 'explicit diagnostic',
      messages,
    });
    expect(messages).toEqual([
      { role: 'user', content: '[Shadow] Would takeover: explicit diagnostic' },
    ]);
  });

  it('does not record shadow events when shadow mode is disabled', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', shadow: false },
      { ICE_SUPERVISOR_MODE: 'adaptive', ICE_SUPERVISOR_SHADOW: '0' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    bridge.recordShadowWouldTakeover({
      round: 1,
      phase: 'free',
      reason: 'ignored',
    });

    expect(bridge.eventTimeline.getRecentEvents()).toEqual([]);
  });

  it('records non-shadow supervisor decisions to timeline', () => {
    const config = resolveSupervisorConfig({ mode: 'strict' }, { ICE_SUPERVISOR_MODE: 'strict' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    bridge.applyDecision(
      {
        action: 'takeover',
        reason: 'risk threshold exceeded',
        signals: [{ type: 'scope_creep' }],
      },
      'free',
      1,
    );
    bridge.applyDecision({ action: 'handoff' }, 'takeover', 4);
    bridge.applyDecision({ action: 'fail', kind: 'rollback' }, 'takeover', 5);
    bridge.applyDecision({ action: 'fail', kind: 'checkpoint' }, 'takeover', 6);

    expect(bridge.eventTimeline.getRecentEvents().map(e => e.event)).toEqual([
      'recover',
      'handoff',
      'rollback',
      'failure',
    ]);
  });

  it('blocks all phase-changing decisions in shadow mode', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', shadow: true },
      { ICE_SUPERVISOR_SHADOW: '1' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    expect(bridge.applyDecision({ action: 'handoff_pending' }, 'takeover', 3)).toEqual({ action: 'continue' });
    expect(bridge.applyDecision({ action: 'handoff' }, 'takeover', 4)).toEqual({ action: 'continue' });
    expect(bridge.applyDecision({ action: 'fail', kind: 'checkpoint' }, 'takeover', 5)).toEqual({ action: 'continue' });

    expect(bridge.eventTimeline.getRecentEvents().map(e => e.reason)).toEqual([
      'would_handoff_pending',
      'would_handoff',
      'would_fail:checkpoint',
    ]);
  });

  it('observeAfterTools records deviation signals to timeline without injecting messages', () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const signals = bridge.observeAfterTools({
      phase: 'free',
      round: { round: 2, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      consecutiveToolFailures: 2,
      consecutiveReadOnlyRounds: 0,
      stableRoundsSinceLastFailure: 0,
      allToolsFailedThisRound: true,
      repeatedToolSignatures: ['run_command:npm test'],
      maxFailedSignatureCount: 2,
      branchRecoverTriggered: false,
      task: {
        goal: 'fix tests',
        intent: 'test',
        domain: 'critical_test',
        filesChanged: [],
        filesRead: [],
        commandsRun: ['npm test'],
        recentFailureCount: 2,
        branchBudgetTriggers: 0,
      },
    });

    expect(signals.length).toBeGreaterThan(0);
    expect(bridge.getAccumulatedDeviationSignals().length).toBeGreaterThan(0);
    expect(bridge.eventTimeline.getRecentEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          round: 2,
          event: 'failure',
          reason: expect.stringContaining('tool_repeat_fail'),
        }),
      ]),
    );
  });

  it('observeAfterTools is no-op when supervisor mode is off', () => {
    const config = resolveSupervisorConfig({ mode: 'off' }, { ICE_SUPERVISOR_MODE: 'off' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const signals = bridge.observeAfterTools({
      phase: 'free',
      round: { round: 1, toolNames: [], toolSuccess: [], hadWriteTool: false },
      consecutiveToolFailures: 10,
      consecutiveReadOnlyRounds: 10,
      stableRoundsSinceLastFailure: 0,
      allToolsFailedThisRound: true,
      repeatedToolSignatures: [],
      maxFailedSignatureCount: 10,
      branchRecoverTriggered: true,
      task: {
        goal: 'x',
        intent: 'edit',
        domain: 'critical_edit',
        filesChanged: [],
        filesRead: [],
        commandsRun: [],
        recentFailureCount: 10,
        branchBudgetTriggers: 1,
      },
    });

    expect(signals).toEqual([]);
    expect(bridge.getAccumulatedDeviationSignals()).toEqual([]);
  });

  it('evaluateAfterRound returns continue when conditions are not met', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const decision = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: [], toolSuccess: [], hadWriteTool: false },
      task: {
        goal: 'fix bug',
        intent: 'debug',
        domain: 'critical_debug',
        filesChanged: [],
        filesRead: [],
        commandsRun: [],
        recentFailureCount: 0,
        branchBudgetTriggers: 0,
      },
      riskScore: 0.2,
    });

    expect(decision).toEqual({ action: 'continue' });
    expect(bridge.getSupervisorPhase()).toBe('free');
  });

  it('buildEvaluateContext carries global shadow flag', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', shadow: true },
      { ICE_SUPERVISOR_SHADOW: '1' },
    );
    const bridge = createSupervisorRuntimeBridge(config);

    const ctx = bridge.buildEvaluateContext({
      phase: 'free',
      round: { round: 1, toolNames: ['read_file'], toolSuccess: [true], hadWriteTool: false },
      task: {
        goal: 'read docs',
        intent: 'question',
        domain: 'non_critical_read',
        filesChanged: [],
        filesRead: ['README.md'],
        commandsRun: [],
        recentFailureCount: 0,
        branchBudgetTriggers: 0,
      },
      signals: [],
      riskScore: 0.1,
    });

    expect(ctx.shadow).toBe(true);
    expect(ctx.mode).toBe('adaptive');
  });
});

describe('SupervisorRuntimeBridge - L2-3 takeover end-to-end', () => {
  const criticalTask = {
    goal: 'fix failing tests',
    intent: 'debug' as const,
    domain: 'critical_debug' as const,
    filesChanged: [],
    filesRead: [],
    commandsRun: [],
    recentFailureCount: 2,
    branchBudgetTriggers: 0,
  };

  function seedRepeatFailures(bridge: ReturnType<typeof createSupervisorRuntimeBridge>): void {
    bridge.observeAfterTools({
      phase: 'free',
      round: { round: 1, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      consecutiveToolFailures: 2,
      consecutiveReadOnlyRounds: 0,
      stableRoundsSinceLastFailure: 0,
      allToolsFailedThisRound: true,
      repeatedToolSignatures: ['run_command:npm test'],
      maxFailedSignatureCount: 3,
      branchRecoverTriggered: false,
      task: criticalTask,
    });
  }

  it('drives free→takeover and injects exactly one takeover block via CorrectionPort', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const messages: UnifiedMessage[] = [];

    seedRepeatFailures(bridge);

    const decision = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      task: criticalTask,
      riskScore: 0.7,
      messages,
    });

    expect(decision.action).toBe('takeover');
    expect(bridge.getSupervisorPhase()).toBe('takeover');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('[System Recovery]');
    expect(messages[0].content).toContain('tool_repeat_fail');

    const recoverEvents = bridge.eventTimeline.getRecentEvents().filter(e => e.event === 'recover');
    expect(recoverEvents).toHaveLength(1);
  });

  it('does NOT mutate supervisorPhase under shadow mode but writes shadow_diagnostic', async () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', shadow: true },
      { ICE_SUPERVISOR_MODE: 'adaptive', ICE_SUPERVISOR_SHADOW: '1' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const messages: UnifiedMessage[] = [];

    seedRepeatFailures(bridge);

    const decision = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      task: criticalTask,
      riskScore: 0.7,
      messages,
    });

    expect(decision).toEqual({ action: 'continue' });
    expect(bridge.getSupervisorPhase()).toBe('free');
    expect(messages).toEqual([]);

    const shadowEvents = bridge.eventTimeline.getRecentEvents().filter(e => e.event === 'shadow_diagnostic');
    expect(shadowEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('off mode short-circuits evaluateAfterRound even with strong signals', async () => {
    const config = resolveSupervisorConfig({ mode: 'off' }, { ICE_SUPERVISOR_MODE: 'off' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const messages: UnifiedMessage[] = [];

    const decision = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: [], toolSuccess: [], hadWriteTool: false },
      task: criticalTask,
      extraSignals: [{ type: 'tool_repeat_fail', count: 9 }],
      riskScore: 0.99,
      messages,
    });

    expect(decision).toEqual({ action: 'continue' });
    expect(bridge.getSupervisorPhase()).toBe('free');
    expect(messages).toEqual([]);
    expect(bridge.eventTimeline.getRecentEvents()).toEqual([]);
  });

  it('extraSignals augments observer-accumulated signals into the evaluator', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const decision = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: [], toolSuccess: [], hadWriteTool: false },
      task: criticalTask,
      extraSignals: [{ type: 'goal_drift', alignment: 0.2 }],
      riskScore: 0.7,
    });

    expect(decision.action).toBe('takeover');
    if (decision.action !== 'takeover') return;
    expect(decision.signals).toEqual([{ type: 'goal_drift', alignment: 0.2 }]);
  });

  it('progresses takeover → handoff_pending → handoff → cooldown across rounds', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    // Round 1: enter takeover via extraSignals (avoid stale observer accumulation across rounds).
    const r1 = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      task: criticalTask,
      extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
      riskScore: 0.7,
    });
    expect(r1.action).toBe('takeover');
    expect(bridge.getSupervisorPhase()).toBe('takeover');

    // Rounds 2-3: stable, accumulate inside takeover (stabilityWindow=3 for adaptiveTakeover).
    for (const round of [2, 3]) {
      const d = await bridge.evaluateAfterRound({
        round: { round, toolNames: ['read_file'], toolSuccess: [true], hadWriteTool: false },
        task: criticalTask,
        riskScore: 0.2,
      });
      expect(d).toEqual({ action: 'continue' });
      expect(bridge.getSupervisorPhase()).toBe('takeover');
    }

    // Round 4: hit stability window → handoff_pending.
    const r4 = await bridge.evaluateAfterRound({
      round: { round: 4, toolNames: ['read_file'], toolSuccess: [true], hadWriteTool: false },
      task: criticalTask,
      riskScore: 0.2,
    });
    expect(r4).toEqual({ action: 'handoff_pending' });
    expect(bridge.getSupervisorPhase()).toBe('handoff_pending');

    // Round 5: handoff fires → cooldown.
    const r5 = await bridge.evaluateAfterRound({
      round: { round: 5, toolNames: ['read_file'], toolSuccess: [true], hadWriteTool: false },
      task: criticalTask,
      riskScore: 0.2,
    });
    expect(r5).toEqual({ action: 'handoff' });
    expect(bridge.getSupervisorPhase()).toBe('cooldown');

    // Cooldown: 3 rounds for adaptiveTakeover before returning to free.
    for (const round of [6, 7, 8]) {
      await bridge.evaluateAfterRound({
        round: { round, toolNames: [], toolSuccess: [], hadWriteTool: false },
        task: criticalTask,
        riskScore: 0.1,
      });
    }
    expect(bridge.getSupervisorPhase()).toBe('free');

    const events = bridge.eventTimeline.getRecentEvents().map(e => e.event);
    expect(events).toEqual(expect.arrayContaining(['recover', 'handoff']));
  });
});

describe('SupervisorRuntimeBridge - L2-4 budget & drift', () => {
  const criticalTask = {
    goal: 'fix failing tests',
    intent: 'debug' as const,
    domain: 'critical_debug' as const,
    filesChanged: [] as string[],
    filesRead: [] as string[],
    commandsRun: [] as string[],
    recentFailureCount: 2,
    branchBudgetTriggers: 0,
  };

  it('escalates to fail{checkpoint} when recovery rounds budget is exhausted', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const r1 = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      task: criticalTask,
      extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
      riskScore: 0.7,
    });
    expect(r1.action).toBe('takeover');
    expect(bridge.getSupervisorPhase()).toBe('takeover');
    expect(bridge.recoveryBudgetManager.isActive()).toBe(true);

    // adaptiveTakeover.maxRecoveryRounds = 3. Keep injecting tool_repeat_fail every round so the
    // supervisor remains in takeover; the budget should escalate to fail{checkpoint} on the round
    // that pushes roundsUsed > 3.
    let exhaustedDecision: Awaited<ReturnType<typeof bridge.evaluateAfterRound>> | undefined;
    let exhaustedAtRound = -1;
    for (let round = 2; round <= 6 && !exhaustedDecision; round++) {
      const d = await bridge.evaluateAfterRound({
        round: { round, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
        task: criticalTask,
        extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
        riskScore: 0.7,
      });
      if (d.action === 'fail') {
        exhaustedDecision = d;
        exhaustedAtRound = round;
      }
    }

    expect(exhaustedDecision).toEqual({ action: 'fail', kind: 'checkpoint' });
    expect(exhaustedAtRound).toBe(4);
    expect(bridge.recoveryBudgetManager.isActive()).toBe(false);

    const failureEvents = bridge.eventTimeline.getRecentEvents().filter(e => e.event === 'failure');
    expect(failureEvents.length).toBeGreaterThan(0);
    expect(failureEvents.some(e => e.reason === 'budget_exhausted:rounds')).toBe(true);
  });

  it('escalates to fail{checkpoint} when token ratio budget is exhausted', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const r1 = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      task: criticalTask,
      extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
      riskScore: 0.7,
      tokenUsage: { used: 100, total: 1000 },
    });
    expect(r1.action).toBe('takeover');

    const r2 = await bridge.evaluateAfterRound({
      round: { round: 2, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      task: criticalTask,
      extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
      riskScore: 0.7,
      tokenUsage: { used: 400, total: 1000 },
    });
    expect(r2).toEqual({ action: 'fail', kind: 'checkpoint' });

    const failureEvents = bridge.eventTimeline.getRecentEvents().filter(e => e.event === 'failure');
    expect(failureEvents.some(e => e.reason === 'budget_exhausted:tokens')).toBe(true);
  });

  it('escalates to fail{checkpoint} when retry budget is exhausted via recordRecoveryRetry', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      task: criticalTask,
      extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
      riskScore: 0.7,
    });
    expect(bridge.getSupervisorPhase()).toBe('takeover');

    // adaptiveTakeover.maxRecoveryRetries = 2 → 3rd retry crosses the line.
    bridge.recordRecoveryRetry('edit_file:src/auth.ts');
    bridge.recordRecoveryRetry('edit_file:src/auth.ts');
    bridge.recordRecoveryRetry('edit_file:src/auth.ts');

    const r2 = await bridge.evaluateAfterRound({
      round: { round: 2, toolNames: ['edit_file'], toolSuccess: [false], hadWriteTool: true },
      task: criticalTask,
      extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
      riskScore: 0.7,
    });
    expect(r2).toEqual({ action: 'fail', kind: 'checkpoint' });
  });

  it('does not consume budget while still in free phase', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: [], toolSuccess: [], hadWriteTool: false },
      task: criticalTask,
      riskScore: 0.2,
      tokenUsage: { used: 999, total: 1000 },
    });
    expect(bridge.recoveryBudgetManager.isActive()).toBe(false);
    expect(bridge.recoveryBudgetManager.snapshot().tokenRatioUsed).toBe(0);
  });

  it('resets budget when supervisor leaves takeover (handoff path)', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
      task: criticalTask,
      extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
      riskScore: 0.7,
    });
    expect(bridge.recoveryBudgetManager.isActive()).toBe(true);

    // adaptiveTakeover.stabilityWindowRounds = 3 → 3 stable rounds reach handoff_pending; 4th = handoff.
    for (const round of [2, 3, 4]) {
      await bridge.evaluateAfterRound({
        round: { round, toolNames: ['read_file'], toolSuccess: [true], hadWriteTool: false },
        task: criticalTask,
        riskScore: 0.2,
      });
    }
    expect(bridge.getSupervisorPhase()).toBe('handoff_pending');

    const handoff = await bridge.evaluateAfterRound({
      round: { round: 5, toolNames: ['read_file'], toolSuccess: [true], hadWriteTool: false },
      task: criticalTask,
      riskScore: 0.2,
    });
    expect(handoff).toEqual({ action: 'handoff' });
    expect(bridge.recoveryBudgetManager.isActive()).toBe(false);
  });

  it('shadow mode does NOT consume recovery budget', async () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', shadow: true },
      { ICE_SUPERVISOR_MODE: 'adaptive', ICE_SUPERVISOR_SHADOW: '1' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    for (let round = 1; round <= 6; round++) {
      await bridge.evaluateAfterRound({
        round: { round, toolNames: ['run_command'], toolSuccess: [false], hadWriteTool: false },
        task: criticalTask,
        extraSignals: [{ type: 'tool_repeat_fail', count: 3 }],
        riskScore: 0.9,
        tokenUsage: { used: 500, total: 1000 },
      });
    }

    expect(bridge.getSupervisorPhase()).toBe('free');
    expect(bridge.recoveryBudgetManager.isActive()).toBe(false);
  });

  it('observeAfterTools emits goal_drift after consecutive low-alignment rounds', () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const driftTask = {
      goal: 'implement new payment endpoint',
      intent: 'edit' as const,
      domain: 'critical_edit' as const,
      filesChanged: [] as string[],
      filesRead: [] as string[],
      commandsRun: [] as string[],
      recentFailureCount: 0,
      branchBudgetTriggers: 0,
    };

    const r1 = bridge.observeAfterTools({
      phase: 'free',
      round: { round: 1, toolNames: ['read_file', 'read_file'], toolSuccess: [true, true], hadWriteTool: false },
      consecutiveToolFailures: 0,
      consecutiveReadOnlyRounds: 1,
      stableRoundsSinceLastFailure: 1,
      allToolsFailedThisRound: false,
      repeatedToolSignatures: [],
      maxFailedSignatureCount: 0,
      branchRecoverTriggered: false,
      task: driftTask,
    });
    expect(r1.find(s => s.type === 'goal_drift')).toBeUndefined();

    const r2 = bridge.observeAfterTools({
      phase: 'free',
      round: { round: 2, toolNames: ['read_file', 'read_file'], toolSuccess: [true, true], hadWriteTool: false },
      consecutiveToolFailures: 0,
      consecutiveReadOnlyRounds: 2,
      stableRoundsSinceLastFailure: 2,
      allToolsFailedThisRound: false,
      repeatedToolSignatures: [],
      maxFailedSignatureCount: 0,
      branchRecoverTriggered: false,
      task: driftTask,
    });
    expect(r2.some(s => s.type === 'goal_drift')).toBe(true);

    const driftEvents = bridge.eventTimeline.getRecentEvents().filter(e => e.event === 'drift');
    expect(driftEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('respects goalDriftEnabled=false toggle', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', triggers: { goalDriftEnabled: false } },
      { ICE_SUPERVISOR_MODE: 'adaptive' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const driftTask = {
      goal: 'implement new payment endpoint',
      intent: 'edit' as const,
      domain: 'critical_edit' as const,
      filesChanged: [] as string[],
      filesRead: [] as string[],
      commandsRun: [] as string[],
      recentFailureCount: 0,
      branchBudgetTriggers: 0,
    };

    for (let round = 1; round <= 5; round++) {
      const signals = bridge.observeAfterTools({
        phase: 'free',
        round: { round, toolNames: ['read_file'], toolSuccess: [true], hadWriteTool: false },
        consecutiveToolFailures: 0,
        consecutiveReadOnlyRounds: round,
        stableRoundsSinceLastFailure: round,
        allToolsFailedThisRound: false,
        repeatedToolSignatures: [],
        maxFailedSignatureCount: 0,
        branchRecoverTriggered: false,
        task: driftTask,
      });
      expect(signals.find(s => s.type === 'goal_drift')).toBeUndefined();
    }
  });

  it('submitManualTrigger accumulates scope_creep / user_force_takeover when triggers enabled', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    expect(bridge.submitManualTrigger({ type: 'scope_creep' }, 1)).toBe(true);
    expect(bridge.submitManualTrigger({ type: 'user_force_takeover' }, 1)).toBe(true);

    const accumulated = bridge.getAccumulatedDeviationSignals();
    expect(accumulated.map(s => s.type)).toEqual(['scope_creep', 'user_force_takeover']);

    const decision = await bridge.evaluateAfterRound({
      round: { round: 1, toolNames: ['edit_file'], toolSuccess: [true], hadWriteTool: true },
      task: { ...criticalTask, domain: 'critical_edit' },
      riskScore: 0.7,
    });
    expect(decision.action).toBe('takeover');
  });

  it('drops scope_creep / user_force_takeover when triggers disabled', () => {
    const config = resolveSupervisorConfig(
      {
        mode: 'adaptive',
        triggers: { scopeCreepEnabled: false, userForceTakeoverEnabled: false },
      },
      { ICE_SUPERVISOR_MODE: 'adaptive' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    expect(bridge.submitManualTrigger({ type: 'scope_creep' }, 1)).toBe(false);
    expect(bridge.submitManualTrigger({ type: 'user_force_takeover' }, 1)).toBe(false);
    expect(bridge.getAccumulatedDeviationSignals()).toEqual([]);
  });

  it('submitManualTrigger is no-op when supervisor mode is off', () => {
    const config = resolveSupervisorConfig({ mode: 'off' }, { ICE_SUPERVISOR_MODE: 'off' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    expect(bridge.submitManualTrigger({ type: 'user_force_takeover' }, 1)).toBe(false);
    expect(bridge.eventTimeline.getRecentEvents()).toEqual([]);
  });

  it('resetObserverSignals clears both observer accumulation and drift streak', () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const driftTask = {
      goal: 'implement new payment endpoint',
      intent: 'edit' as const,
      domain: 'critical_edit' as const,
      filesChanged: [] as string[],
      filesRead: [] as string[],
      commandsRun: [] as string[],
      recentFailureCount: 0,
      branchBudgetTriggers: 0,
    };

    bridge.observeAfterTools({
      phase: 'free',
      round: { round: 1, toolNames: ['read_file'], toolSuccess: [true], hadWriteTool: false },
      consecutiveToolFailures: 0,
      consecutiveReadOnlyRounds: 1,
      stableRoundsSinceLastFailure: 1,
      allToolsFailedThisRound: false,
      repeatedToolSignatures: [],
      maxFailedSignatureCount: 0,
      branchRecoverTriggered: false,
      task: driftTask,
    });

    bridge.resetObserverSignals();
    expect(bridge.getAccumulatedDeviationSignals()).toEqual([]);
    expect(bridge.goalDriftDetector.getRecentHistory()).toEqual([]);
  });
});

describe('SupervisorRuntimeBridge - L2-5 recovery main path', () => {
  const criticalTask = {
    goal: 'fix failing tests',
    intent: 'debug' as const,
    domain: 'critical_debug' as const,
    filesChanged: ['src/login.ts'],
    filesRead: [] as string[],
    commandsRun: [] as string[],
    recentFailureCount: 2,
    branchBudgetTriggers: 0,
  };

  function buildExtractInput(verification: 'passed' | 'failed' | 'required' | 'not_required'): {
    task: {
      goal: string;
      intent: 'debug';
      phase: 'editing';
      filesRead: string[];
      filesChanged: string[];
      commandsRun: string[];
      verificationRequired: boolean;
      verificationStatus: typeof verification;
    };
    repo: {
      filesRead: string[];
      filesChanged: string[];
      commandsRun: string[];
      testCommands: string[];
      recentDiagnostics: string[];
    };
  } {
    return {
      task: {
        goal: 'fix failing tests',
        intent: 'debug',
        phase: 'editing',
        filesRead: ['src/login.ts'],
        filesChanged: ['src/login.ts'],
        commandsRun: ['npm test'],
        verificationRequired: true,
        verificationStatus: verification,
      },
      repo: {
        filesRead: ['src/login.ts'],
        filesChanged: ['src/login.ts'],
        commandsRun: ['npm test'],
        testCommands: ['npm test'],
        recentDiagnostics: [],
      },
    };
  }

  function forceTakeover(bridge: ReturnType<typeof createSupervisorRuntimeBridge>): void {
    bridge.recoverySupervisor.commit({
      phase: 'takeover',
      takeoverStartRound: 1,
      stableRoundsInTakeover: 0,
      cooldownRemaining: 0,
    });
  }

  it('returns strong_hint when supervisor is off (no executor side-effect)', () => {
    const config = resolveSupervisorConfig({ mode: 'off' }, { ICE_SUPERVISOR_MODE: 'off' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const result = bridge.runRecoveryMainPath({
      round: 1,
      task: criticalTask,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
      extractInput: buildExtractInput('passed'),
      confidenceInput: { roundsSinceExtract: 0, lastVerifyPassed: true },
    });

    expect(result.tier).toBe('strong_hint');
    expect(result.fallbackReason).toBe('no_executor');
    expect(bridge.eventTimeline.getRecentEvents()).toEqual([]);
  });

  it('writes a failure timeline diagnostic when phase != takeover', () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const result = bridge.runRecoveryMainPath({
      round: 2,
      task: criticalTask,
      signals: [],
      extractInput: buildExtractInput('passed'),
      confidenceInput: { roundsSinceExtract: 0, lastVerifyPassed: true },
    });

    expect(result.tier).toBe('strong_hint');
    expect(result.fallbackReason).toBe('no_executor');
    expect(bridge.eventTimeline.getRecentEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'failure',
          reason: 'recovery_main_path_skipped:not_in_takeover',
        }),
      ]),
    );
  });

  it('takes §10 main path with template_graph tier when all gates pass', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    forceTakeover(bridge);

    const { GraphExecutor } = await import('../../src/harness/task-graph-executor.js');
    const executor = new GraphExecutor();

    const result = bridge.runRecoveryMainPath({
      round: 5,
      task: criticalTask,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
      extractInput: buildExtractInput('passed'),
      confidenceInput: { roundsSinceExtract: 0, lastVerifyPassed: true, repoFilesChanged: ['src/login.ts'] },
      graphExecutor: executor,
    });

    expect(result.tier).toBe('template_graph');
    expect(result.graph).not.toBeNull();
    expect(executor.hasGraph()).toBe(true);
    expect(executor.isInTakeover()).toBe(true);
    expect(executor.getEvaluationMode()).toBe('metrics_only');

    const recoverEvents = bridge.eventTimeline.getRecentEvents().filter((e) => e.event === 'recover');
    expect(recoverEvents).toHaveLength(1);
    expect(recoverEvents[0].reason).toContain('template_graph:');
  });

  it('falls back to strong_hint and injects [System Recovery] when confidence is low', () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    forceTakeover(bridge);

    const messages: UnifiedMessage[] = [];
    const result = bridge.runRecoveryMainPath({
      round: 6,
      task: criticalTask,
      signals: [{ type: 'no_progress', rounds: 4 }],
      extractInput: buildExtractInput('failed'),
      confidenceInput: { roundsSinceExtract: 5, lastVerifyPassed: false },
      messages,
    });

    expect(result.tier).toBe('strong_hint');
    expect(result.fallbackReason).toBe('low_confidence');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('[System Recovery]');
    expect(messages[0].content).toContain('low_confidence');
    expect(messages[0].content).toContain('no_progress:4');

    const recoverEvents = bridge.eventTimeline.getRecentEvents().filter((e) => e.event === 'recover');
    expect(recoverEvents).toHaveLength(1);
    expect(recoverEvents[0].reason).toContain('strong_hint:low_confidence');
  });

  it('falls back when safety check rejects the workspace', () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' }, { ICE_SUPERVISOR_MODE: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    forceTakeover(bridge);

    const messages: UnifiedMessage[] = [];
    const result = bridge.runRecoveryMainPath({
      round: 7,
      task: criticalTask,
      signals: [],
      extractInput: buildExtractInput('passed'),
      confidenceInput: { roundsSinceExtract: 0, lastVerifyPassed: true, repoFilesChanged: ['src/login.ts'] },
      safetyInput: { branchHealthy: false },
      messages,
    });

    expect(result.tier).toBe('strong_hint');
    expect(result.fallbackReason).toBe('unsafe');
    expect(result.safety.reasons).toContain('branch_unhealthy');
    expect(messages[0].content).toContain('unsafe');
  });

  it('shadow mode does not mutate executor nor inject correction messages', async () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', shadow: true },
      { ICE_SUPERVISOR_MODE: 'adaptive', ICE_SUPERVISOR_SHADOW: '1' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    forceTakeover(bridge);

    const { GraphExecutor } = await import('../../src/harness/task-graph-executor.js');
    const executor = new GraphExecutor();
    const messages: UnifiedMessage[] = [];

    const result = bridge.runRecoveryMainPath({
      round: 8,
      task: criticalTask,
      signals: [],
      extractInput: buildExtractInput('passed'),
      confidenceInput: { roundsSinceExtract: 0, lastVerifyPassed: true, repoFilesChanged: ['src/login.ts'] },
      graphExecutor: executor,
      messages,
    });

    expect(result.tier).toBe('template_graph');
    expect(executor.hasGraph()).toBe(false);
    expect(executor.isInTakeover()).toBe(false);
    expect(messages).toEqual([]);
  });
});

describe('SupervisorRuntimeBridge - L2-6 hooks · checkpoint · I4 budget', () => {
  const criticalTask = {
    goal: 'fix critical bug in login module',
    intent: 'debug' as const,
    domain: 'critical_debug' as const,
    filesChanged: ['src/login.ts'],
    filesRead: [] as string[],
    commandsRun: [] as string[],
    recentFailureCount: 3,
    branchBudgetTriggers: 0,
  };

  function buildRound(round: number) {
    return {
      round,
      toolNames: ['edit_file'],
      toolSuccess: [false],
      hadWriteTool: true,
    };
  }

  it('createCorrectionPort: drops free-segment supervisor recovery once freeSegmentMaxPerTask is reached', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', correctionBudget: { freeSegmentMaxPerTask: 1 } },
      { ICE_SUPERVISOR_MODE: 'adaptive' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const messages: UnifiedMessage[] = [];
    const port = bridge.createCorrectionPort(messages);

    port.inject(
      { kind: 'recovery', content: '[Sys] first recovery' },
      { phase: 'free', source: 'supervisor' },
    );
    port.inject(
      { kind: 'recovery', content: '[Sys] second recovery (should be dropped)' },
      { phase: 'free', source: 'supervisor' },
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain('first recovery');

    const budget = bridge.getCorrectionBudgetUsage();
    expect(budget.used).toBe(1);
    expect(budget.rejected).toBe(1);

    const failureEvents = bridge.eventTimeline
      .getRecentEvents()
      .filter((e) => e.event === 'failure');
    expect(failureEvents.some((e) => e.reason === 'correction_budget_exhausted:recovery')).toBe(true);
  });

  it('createCorrectionPort: budget rejection timeline carries the supplied round', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', correctionBudget: { freeSegmentMaxPerTask: 1 } },
      { ICE_SUPERVISOR_MODE: 'adaptive' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const messages: UnifiedMessage[] = [];
    const port = bridge.createCorrectionPort(messages, 7);

    port.inject(
      { kind: 'recovery', content: '[Sys] first recovery' },
      { phase: 'free', source: 'supervisor' },
    );
    port.inject(
      { kind: 'recovery', content: '[Sys] second recovery (should be dropped)' },
      { phase: 'free', source: 'supervisor', round: 9 },
    );

    const budgetFailure = bridge.eventTimeline
      .getRecentEvents()
      .find((e) => e.event === 'failure' && e.reason === 'correction_budget_exhausted:recovery');

    expect(budgetFailure?.round).toBe(9);
  });

  it('createCorrectionPort: takeover-phase recovery bypasses I4 budget (counted only on free)', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', correctionBudget: { freeSegmentMaxPerTask: 1 } },
      { ICE_SUPERVISOR_MODE: 'adaptive' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const messages: UnifiedMessage[] = [];
    const port = bridge.createCorrectionPort(messages);

    for (let i = 0; i < 3; i++) {
      port.inject(
        { kind: 'recovery', content: `[Sys] takeover ${i}` },
        { phase: 'takeover', source: 'supervisor' },
      );
    }

    expect(messages).toHaveLength(3);
    expect(bridge.getCorrectionBudgetUsage().used).toBe(0);
  });

  it('createCorrectionPort: lifecycle source is not counted against the budget', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', correctionBudget: { freeSegmentMaxPerTask: 1 } },
      { ICE_SUPERVISOR_MODE: 'adaptive' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const messages: UnifiedMessage[] = [];
    const port = bridge.createCorrectionPort(messages);

    port.inject(
      { kind: 'recovery', content: '[Lifecycle] read-only nag' },
      { phase: 'free', source: 'lifecycle' },
    );
    port.inject(
      { kind: 'recovery', content: '[Supervisor] free recovery' },
      { phase: 'free', source: 'supervisor' },
    );

    expect(messages).toHaveLength(2);
    expect(bridge.getCorrectionBudgetUsage().used).toBe(1);
  });

  it('createCorrectionPort: off mode keeps inject untouched (no budget enforcement)', () => {
    const config = resolveSupervisorConfig(
      { mode: 'off', correctionBudget: { freeSegmentMaxPerTask: 1 } },
      { ICE_SUPERVISOR_MODE: 'off' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    const messages: UnifiedMessage[] = [];
    const port = bridge.createCorrectionPort(messages);

    port.inject(
      { kind: 'recovery', content: 'msg1' },
      { phase: 'free', source: 'supervisor' },
    );
    port.inject(
      { kind: 'recovery', content: 'msg2' },
      { phase: 'free', source: 'supervisor' },
    );

    // off：bridge.createCorrectionPort 退回普通 port，无 budget。
    expect(messages).toHaveLength(2);
    expect(bridge.getCorrectionBudgetUsage().rejected).toBe(0);
  });

  it('evaluateAfterRound returns fail{checkpoint} when recovery budget is exhausted', async () => {
    const config = resolveSupervisorConfig(
      {
        mode: 'adaptive',
        params: {
          adaptiveTakeover: { maxRecoveryRounds: 1, recoveryTokenRatio: 0.5, maxRecoveryRetries: 1 },
        },
      },
      { ICE_SUPERVISOR_MODE: 'adaptive' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    // 注入异常信号让首轮进入 takeover。
    bridge.passiveObserver.observe({
      phase: 'free',
      round: buildRound(1),
      consecutiveToolFailures: 3,
      consecutiveReadOnlyRounds: 0,
      stableRoundsSinceLastFailure: 0,
      allToolsFailedThisRound: true,
      repeatedToolSignatures: ['edit_file:abc', 'edit_file:abc', 'edit_file:abc'],
      maxFailedSignatureCount: 3,
      branchRecoverTriggered: true,
      task: criticalTask,
    });

    const first = await bridge.evaluateAfterRound({
      round: buildRound(1),
      task: criticalTask,
      riskScore: 1,
    });
    expect(first.action).toBe('takeover');
    expect(bridge.getSupervisorPhase()).toBe('takeover');

    // 第二轮 takeover 段：再 tick 一次预算 → 超过 maxRecoveryRounds (=1)。
    bridge.passiveObserver.observe({
      phase: 'takeover',
      round: buildRound(2),
      consecutiveToolFailures: 4,
      consecutiveReadOnlyRounds: 0,
      stableRoundsSinceLastFailure: 0,
      allToolsFailedThisRound: true,
      repeatedToolSignatures: ['edit_file:abc'],
      maxFailedSignatureCount: 4,
      branchRecoverTriggered: true,
      task: criticalTask,
    });

    const second = await bridge.evaluateAfterRound({
      round: buildRound(2),
      task: criticalTask,
      riskScore: 1,
    });
    expect(second.action).toBe('fail');
    if (second.action === 'fail') expect(second.kind).toBe('checkpoint');

    const failureReasons = bridge.eventTimeline
      .getRecentEvents()
      .filter((e) => e.event === 'failure')
      .map((e) => e.reason);
    expect(failureReasons).toEqual(
      expect.arrayContaining([expect.stringContaining('budget_exhausted')]),
    );
  });

  it('snapshotForCheckpoint then restoreFromCheckpoint round-trips phase / timeline tail / budget', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', correctionBudget: { freeSegmentMaxPerTask: 5 } },
      { ICE_SUPERVISOR_MODE: 'adaptive' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    // 推进 phase 到 takeover、写一条 switch 到 timeline、并消耗 2 次 budget。
    bridge.recoverySupervisor.commit({
      phase: 'takeover',
      takeoverStartRound: 4,
      stableRoundsInTakeover: 1,
      cooldownRemaining: 0,
    });
    bridge.recordExecutionModeSwitch({ round: 4, from: 'free', to: 'forced', reason: 'pending_steps' });
    const messages: UnifiedMessage[] = [];
    const port = bridge.createCorrectionPort(messages);
    port.inject({ kind: 'recovery', content: 'a' }, { phase: 'free', source: 'supervisor' });
    port.inject({ kind: 'recovery', content: 'b' }, { phase: 'free', source: 'supervisor' });

    const snap = bridge.snapshotForCheckpoint();
    expect(snap.supervisorPhase).toBe('takeover');
    expect(snap.recoverySupervisorSnapshot?.takeoverStartRound).toBe(4);
    expect(snap.correctionBudgetUsed).toBe(2);
    expect(Array.isArray(snap.timelineTail)).toBe(true);
    expect((snap.timelineTail ?? []).some((e) => e.event === 'switch')).toBe(true);

    // 复位另一个 bridge，恢复后断言状态被推回。
    const restored = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    expect(restored.getSupervisorPhase()).toBe('free');

    restored.restoreFromCheckpoint({
      executionMode: 'forced',
      executionModeLockRemaining: 0,
      executionModeEnteredBy: [],
      executionModeEnteredAtRound: 4,
      pendingModeSignals: [],
      forcedTaskBearingRoundsSinceEntry: 0,
      supervisorPhase: snap.supervisorPhase,
      recoverySupervisorSnapshot: snap.recoverySupervisorSnapshot,
      timelineTail: snap.timelineTail,
      correctionBudgetUsed: snap.correctionBudgetUsed,
    });

    expect(restored.getSupervisorPhase()).toBe('takeover');
    expect(restored.recoverySupervisor.getSnapshot().takeoverStartRound).toBe(4);
    expect(restored.getCorrectionBudgetUsage().used).toBe(2);

    // 恢复时应额外写一条 checkpoint_resumed timeline 标记。
    const resumedMarkers = restored.eventTimeline
      .getRecentEvents()
      .filter((e) => e.event === 'failure' && e.reason === 'checkpoint_resumed');
    expect(resumedMarkers).toHaveLength(1);
  });

  it('restoreFromCheckpoint is a no-op when supervisor is off', () => {
    const config = resolveSupervisorConfig({ mode: 'off' }, { ICE_SUPERVISOR_MODE: 'off' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    bridge.restoreFromCheckpoint({
      executionMode: 'free',
      executionModeLockRemaining: 0,
      executionModeEnteredBy: [],
      executionModeEnteredAtRound: null,
      pendingModeSignals: [],
      forcedTaskBearingRoundsSinceEntry: 0,
      supervisorPhase: 'takeover',
      recoverySupervisorSnapshot: {
        phase: 'takeover',
        takeoverStartRound: 1,
        stableRoundsInTakeover: 0,
        cooldownRemaining: 0,
      },
      correctionBudgetUsed: 7,
    });

    expect(bridge.getSupervisorPhase()).toBe('free');
    expect(bridge.getCorrectionBudgetUsage().used).toBe(0);
    expect(bridge.eventTimeline.getRecentEvents()).toEqual([]);
  });

  it('resetForNewTask wipes phase / observer / budget for the next task', () => {
    const config = resolveSupervisorConfig(
      { mode: 'adaptive', correctionBudget: { freeSegmentMaxPerTask: 1 } },
      { ICE_SUPERVISOR_MODE: 'adaptive' },
    );
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
    bridge.recoverySupervisor.commit({
      phase: 'takeover',
      takeoverStartRound: 1,
      stableRoundsInTakeover: 0,
      cooldownRemaining: 0,
    });
    const messages: UnifiedMessage[] = [];
    bridge.createCorrectionPort(messages).inject(
      { kind: 'recovery', content: 'one' },
      { phase: 'free', source: 'supervisor' },
    );
    expect(bridge.getCorrectionBudgetUsage().used).toBe(1);

    bridge.resetForNewTask();

    expect(bridge.getSupervisorPhase()).toBe('free');
    expect(bridge.getCorrectionBudgetUsage().used).toBe(0);
    expect(bridge.passiveObserver.getAccumulated()).toEqual([]);
  });
});

describe('SupervisorRuntimeBridge - L2-7 (mode & gating)', () => {
  describe('shouldInitTaskGraphAtFirstRound', () => {
    it('off mode: backward compat — returns true for critical intents (= shouldUseTaskGraph)', () => {
      const config = resolveSupervisorConfig({ mode: 'off' }, { ICE_SUPERVISOR_MODE: 'off' });
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

      expect(bridge.shouldInitTaskGraphAtFirstRound('edit')).toBe(true);
      expect(bridge.shouldInitTaskGraphAtFirstRound('refactor')).toBe(true);
      expect(bridge.shouldInitTaskGraphAtFirstRound('inspect')).toBe(false);
      expect(bridge.shouldInitTaskGraphAtFirstRound('question')).toBe(false);
    });

    it('adaptive mode: §I3 — critical intents do NOT init at round 1 (adaptiveFree.firstRoundGraph=false)', () => {
      const config = resolveSupervisorConfig(
        { mode: 'adaptive' },
        { ICE_SUPERVISOR_MODE: 'adaptive' },
      );
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

      expect(bridge.shouldInitTaskGraphAtFirstRound('edit')).toBe(false);
      expect(bridge.shouldInitTaskGraphAtFirstRound('refactor')).toBe(false);
      expect(bridge.shouldInitTaskGraphAtFirstRound('debug')).toBe(false);
      expect(bridge.shouldInitTaskGraphAtFirstRound('test')).toBe(false);
      // 非关键 intent 一律 false（不论 mode）
      expect(bridge.shouldInitTaskGraphAtFirstRound('inspect')).toBe(false);
    });

    it('strict mode: critical intents init at round 1 (strict.firstRoundGraph=true)', () => {
      const config = resolveSupervisorConfig(
        { mode: 'strict' },
        { ICE_SUPERVISOR_MODE: 'strict' },
      );
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

      expect(bridge.shouldInitTaskGraphAtFirstRound('edit')).toBe(true);
      expect(bridge.shouldInitTaskGraphAtFirstRound('refactor')).toBe(true);
      expect(bridge.shouldInitTaskGraphAtFirstRound('debug')).toBe(true);
      expect(bridge.shouldInitTaskGraphAtFirstRound('test')).toBe(true);
      // 非关键 intent 仍 false（strict 也不强制为非关键域建图）
      expect(bridge.shouldInitTaskGraphAtFirstRound('inspect')).toBe(false);
      expect(bridge.shouldInitTaskGraphAtFirstRound('question')).toBe(false);
    });

    it('respects user override: strict can disable firstRoundGraph via config', () => {
      const config = resolveSupervisorConfig(
        { mode: 'strict', params: { strict: { firstRoundGraph: false } } },
        { ICE_SUPERVISOR_MODE: 'strict' },
      );
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

      expect(bridge.shouldInitTaskGraphAtFirstRound('edit')).toBe(false);
    });
  });

  describe('composeGraphHint', () => {
    it('drops graph hint in free mode (no inject / no timeline write)', () => {
      const config = resolveSupervisorConfig(
        { mode: 'adaptive' },
        { ICE_SUPERVISOR_MODE: 'adaptive' },
      );
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
      const messages: UnifiedMessage[] = [];
      const port = bridge.createCorrectionPort(messages);

      const routing = bridge.composeGraphHint({
        round: 2,
        executionMode: 'free',
        port,
        phase: 'free',
        input: { origin: 'evaluate_round', action: 'force_switch', message: '[Graph] retry on fallback' },
      });

      expect(routing.injectToCorrectionPort).toBe(false);
      expect(messages).toEqual([]);
      const recover = bridge.eventTimeline.getRecentEvents().filter((e) => e.event === 'recover');
      expect(recover).toEqual([]);
    });

    it('injects via CorrectionPort under forced mode and records `recover:graph_hint:*` timeline', () => {
      const config = resolveSupervisorConfig(
        { mode: 'adaptive' },
        { ICE_SUPERVISOR_MODE: 'adaptive' },
      );
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
      const messages: UnifiedMessage[] = [];
      const port = bridge.createCorrectionPort(messages);

      const routing = bridge.composeGraphHint({
        round: 5,
        executionMode: 'forced',
        port,
        phase: 'takeover',
        input: {
          origin: 'evaluate_round',
          action: 'inject_hint',
          message: '[Graph] Use read_file before edit_file.',
        },
      });

      expect(routing.injectToCorrectionPort).toBe(true);
      expect(messages).toEqual([
        { role: 'user', content: '[Graph] Use read_file before edit_file.' },
      ]);
      const recover = bridge.eventTimeline.getRecentEvents().filter((e) => e.event === 'recover');
      expect(recover).toHaveLength(1);
      expect(recover[0]?.reason).toBe('graph_hint:evaluate_round');
    });

    it('strict-style mapping: warn action is treated as inject_hint when forced', () => {
      const config = resolveSupervisorConfig(
        { mode: 'strict' },
        { ICE_SUPERVISOR_MODE: 'strict' },
      );
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
      const messages: UnifiedMessage[] = [];
      const port = bridge.createCorrectionPort(messages);

      const routing = bridge.composeGraphHint({
        round: 1,
        executionMode: 'forced',
        port,
        phase: 'free',
        input: { origin: 'forced_step', kind: 'warn', message: '[Graph] edit_file outside current step' },
      });

      expect(routing.injectToCorrectionPort).toBe(true);
      expect(messages).toHaveLength(1);
      const recover = bridge.eventTimeline.getRecentEvents().filter((e) => e.event === 'recover');
      expect(recover[0]?.reason).toBe('graph_hint:forced_step_warn');
    });

    it('forced_step block origin records forced_step_block timeline reason', () => {
      const config = resolveSupervisorConfig(
        { mode: 'strict' },
        { ICE_SUPERVISOR_MODE: 'strict' },
      );
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
      const messages: UnifiedMessage[] = [];
      const port = bridge.createCorrectionPort(messages);

      const routing = bridge.composeGraphHint({
        round: 3,
        executionMode: 'forced',
        port,
        phase: 'takeover',
        input: {
          origin: 'forced_step',
          kind: 'block',
          message: '[ToolGate] All tool calls were blocked.',
        },
      });

      expect(routing.injectToCorrectionPort).toBe(true);
      expect(messages).toHaveLength(1);
      const recover = bridge.eventTimeline.getRecentEvents().filter((e) => e.event === 'recover');
      expect(recover[0]?.reason).toBe('graph_hint:forced_step_block');
    });

    it('no message → no inject and no timeline write', () => {
      const config = resolveSupervisorConfig(
        { mode: 'adaptive' },
        { ICE_SUPERVISOR_MODE: 'adaptive' },
      );
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
      const messages: UnifiedMessage[] = [];
      const port = bridge.createCorrectionPort(messages);

      const routing = bridge.composeGraphHint({
        round: 1,
        executionMode: 'forced',
        port,
        phase: 'free',
        input: { origin: 'evaluate_round', action: 'none', message: undefined },
      });

      expect(routing).toEqual({ injectToCorrectionPort: false, emitTelemetry: false });
      expect(messages).toEqual([]);
    });
  });

  describe('createCorrectionPort wires RecoveryBoundary', () => {
    it('writes a `failure:recovery_boundary_rejected:*` timeline when boundary rejects', () => {
      const config = resolveSupervisorConfig(
        { mode: 'adaptive' },
        { ICE_SUPERVISOR_MODE: 'adaptive' },
      );
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
      const messages: UnifiedMessage[] = [];
      const port = bridge.createCorrectionPort(messages);

      // free + supervisor + takeover-block → boundary 拒绝
      port.inject(
        { kind: 'takeover', content: 'should be dropped by boundary' },
        { phase: 'free', source: 'supervisor' },
      );

      expect(messages).toEqual([]);
      const failures = bridge.eventTimeline
        .getRecentEvents()
        .filter((e) => e.event === 'failure' && e.reason.startsWith('recovery_boundary_rejected:'));
      expect(failures).toHaveLength(1);
      expect(failures[0]?.reason).toBe('recovery_boundary_rejected:free_phase_rejects_takeover_block');
    });

    it('off mode: boundary not attached, legacy shouldSuppress still drops free+takeover', () => {
      const config = resolveSupervisorConfig({ mode: 'off' }, { ICE_SUPERVISOR_MODE: 'off' });
      const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });
      const messages: UnifiedMessage[] = [];
      const port = bridge.createCorrectionPort(messages);

      port.inject(
        { kind: 'takeover', content: 'legacy dropped' },
        { phase: 'free', source: 'supervisor' },
      );

      expect(messages).toEqual([]);
      // off：boundary 不挂，不会写 recovery_boundary_rejected timeline
      expect(bridge.eventTimeline.getRecentEvents()).toEqual([]);
    });
  });
});
