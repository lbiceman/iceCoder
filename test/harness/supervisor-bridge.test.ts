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

  it('evaluateAfterRound returns continue as L2-3 skeleton', async () => {
    const config = resolveSupervisorConfig({ mode: 'adaptive' });
    const bridge = createSupervisorRuntimeBridge(config, { memoryOnly: true });

    const decision = await bridge.evaluateAfterRound({
      phase: 'free',
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
      signals: [],
      riskScore: 0.2,
    });

    expect(decision).toEqual({ action: 'continue' });
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
