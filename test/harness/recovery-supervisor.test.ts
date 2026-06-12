import { describe, expect, it } from 'vitest';

import type { UnifiedMessage } from '../../src/llm/types.js';
import { MessageCorrectionPort } from '../../src/harness/supervisor/correction-port.js';
import {
  RecoverySupervisor,
  formatTakeoverReason,
} from '../../src/harness/supervisor/recovery-supervisor.js';
import { defaultSupervisorConfig } from '../../src/harness/supervisor/supervisor-config.js';
import type {
  DeviationSignal,
  SupervisorEvaluateContext,
  SupervisorMode,
  SupervisorParams,
  TaskContext,
  TaskDomain,
} from '../../src/types/supervisor.js';

const params: SupervisorParams = defaultSupervisorConfig().params;

function makeTask(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    goal: 'fix failing tests',
    intent: 'debug',
    domain: 'critical_debug',
    filesChanged: [],
    filesRead: [],
    commandsRun: [],
    recentFailureCount: 0,
    branchBudgetTriggers: 0,
    ...overrides,
  };
}

function ctxWith(overrides: {
  round?: number;
  mode?: SupervisorMode;
  shadow?: boolean;
  riskScore?: number;
  signals?: DeviationSignal[];
  domain?: TaskDomain;
  phase?: SupervisorEvaluateContext['phase'];
}): SupervisorEvaluateContext {
  return {
    phase: overrides.phase ?? 'free',
    mode: overrides.mode ?? 'adaptive',
    shadow: overrides.shadow ?? false,
    round: {
      round: overrides.round ?? 1,
      toolNames: ['run_command'],
      toolSuccess: [false],
      hadWriteTool: false,
    },
    signals: overrides.signals ?? [],
    riskScore: overrides.riskScore ?? 0.7,
    task: makeTask(overrides.domain ? { domain: overrides.domain } : {}),
  };
}

describe('RecoverySupervisor - §9 三条件接管', () => {
  it('continues when only conditions 1 and 2 satisfied (no signal)', () => {
    const supervisor = new RecoverySupervisor(params);
    const decision = supervisor.evaluate(ctxWith({ signals: [], riskScore: 0.8 }));
    expect(decision).toEqual({ action: 'continue' });
    expect(supervisor.getPhase()).toBe('free');
  });

  it('continues when domain is non-critical even with high risk + signal', () => {
    const supervisor = new RecoverySupervisor(params);
    const decision = supervisor.evaluate(ctxWith({
      domain: 'non_critical_read',
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
      riskScore: 0.9,
    }));
    expect(decision).toEqual({ action: 'continue' });
    expect(supervisor.getPhase()).toBe('free');
  });

  it('continues when risk below adaptiveFree threshold even with signals', () => {
    const supervisor = new RecoverySupervisor(params);
    const decision = supervisor.evaluate(ctxWith({
      riskScore: 0.55,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
    }));
    expect(decision).toEqual({ action: 'continue' });
    expect(supervisor.getPhase()).toBe('free');
  });

  it('enters takeover when all three conditions hold (adaptive)', () => {
    const supervisor = new RecoverySupervisor(params);
    const signals: DeviationSignal[] = [{ type: 'tool_repeat_fail', count: 3 }];
    const decision = supervisor.evaluate(ctxWith({ riskScore: 0.7, signals, round: 5 }));

    expect(decision.action).toBe('takeover');
    if (decision.action !== 'takeover') return;
    expect(decision.signals).toEqual(signals);
    expect(decision.reason).toBe('tool_repeat_fail:3');
    expect(supervisor.getPhase()).toBe('takeover');
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'takeover',
      takeoverStartRound: 5,
      stableRoundsInTakeover: 0,
    });
  });

  it('does not enter takeover in strict mode (§9 仅 adaptive)', () => {
    const supervisor = new RecoverySupervisor(params);
    const decision = supervisor.evaluate(ctxWith({
      mode: 'strict',
      riskScore: 0.9,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
    }));
    expect(decision).toEqual({ action: 'continue' });
    expect(supervisor.getPhase()).toBe('free');
  });
});

describe('RecoverySupervisor - §18 状态机推进', () => {
  function makeAndEnterTakeover(): RecoverySupervisor {
    const supervisor = new RecoverySupervisor(params);
    supervisor.evaluate(ctxWith({
      riskScore: 0.7,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
      round: 1,
    }));
    expect(supervisor.getPhase()).toBe('takeover');
    return supervisor;
  }

  it('accumulates stable rounds without leaving takeover until window reached', () => {
    const supervisor = makeAndEnterTakeover();
    // adaptiveTakeover.stabilityWindowRounds = 3
    const d1 = supervisor.evaluate(ctxWith({ round: 2, signals: [] }));
    expect(d1).toEqual({ action: 'continue' });
    expect(supervisor.getSnapshot().stableRoundsInTakeover).toBe(1);

    const d2 = supervisor.evaluate(ctxWith({ round: 3, signals: [] }));
    expect(d2).toEqual({ action: 'continue' });
    expect(supervisor.getSnapshot().stableRoundsInTakeover).toBe(2);

    const d3 = supervisor.evaluate(ctxWith({ round: 4, signals: [] }));
    expect(d3).toEqual({ action: 'handoff_pending' });
    expect(supervisor.getPhase()).toBe('handoff_pending');
  });

  it('resets stable counter when new signal arrives during takeover', () => {
    const supervisor = makeAndEnterTakeover();
    supervisor.evaluate(ctxWith({ round: 2, signals: [] }));
    expect(supervisor.getSnapshot().stableRoundsInTakeover).toBe(1);

    supervisor.evaluate(ctxWith({ round: 3, signals: [{ type: 'no_progress', rounds: 3 }] }));
    expect(supervisor.getSnapshot().stableRoundsInTakeover).toBe(0);
    expect(supervisor.getPhase()).toBe('takeover');
  });

  it('transitions handoff_pending → cooldown on stable round (decision=handoff)', () => {
    const supervisor = makeAndEnterTakeover();
    supervisor.evaluate(ctxWith({ round: 2, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 3, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 4, signals: [] }));
    expect(supervisor.getPhase()).toBe('handoff_pending');

    const decision = supervisor.evaluate(ctxWith({ round: 5, signals: [] }));
    expect(decision).toEqual({ action: 'handoff' });
    expect(supervisor.getPhase()).toBe('cooldown');
    // adaptiveTakeover.handoffCooldownRounds = 3
    expect(supervisor.getSnapshot().cooldownRemaining).toBe(3);
  });

  it('reverts handoff_pending → takeover when new signal arrives (§12.2 失败：继续接管)', () => {
    const supervisor = makeAndEnterTakeover();
    supervisor.evaluate(ctxWith({ round: 2, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 3, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 4, signals: [] }));
    expect(supervisor.getPhase()).toBe('handoff_pending');

    const decision = supervisor.evaluate(ctxWith({
      round: 5,
      signals: [{ type: 'file_loop', path: 'src/a.ts', count: 4 }],
    }));
    expect(decision).toEqual({ action: 'continue' });
    expect(supervisor.getPhase()).toBe('takeover');
    expect(supervisor.getSnapshot().stableRoundsInTakeover).toBe(0);
  });

  it('cooldown decrements and returns to free when remaining hits zero', () => {
    const supervisor = makeAndEnterTakeover();
    supervisor.evaluate(ctxWith({ round: 2, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 3, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 4, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 5, signals: [] }));
    expect(supervisor.getPhase()).toBe('cooldown');
    expect(supervisor.getSnapshot().cooldownRemaining).toBe(3);

    supervisor.evaluate(ctxWith({ round: 6, signals: [] }));
    expect(supervisor.getSnapshot().cooldownRemaining).toBe(2);
    expect(supervisor.getPhase()).toBe('cooldown');

    supervisor.evaluate(ctxWith({ round: 7, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 8, signals: [] }));
    expect(supervisor.getPhase()).toBe('free');
    expect(supervisor.getSnapshot()).toMatchObject({
      phase: 'free',
      takeoverStartRound: -1,
      stableRoundsInTakeover: 0,
      cooldownRemaining: 0,
    });
  });

  it('stays in cooldown when only weak signals arrive', () => {
    const supervisor = makeAndEnterTakeover();
    supervisor.evaluate(ctxWith({ round: 2, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 3, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 4, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 5, signals: [] }));
    expect(supervisor.getPhase()).toBe('cooldown');

    // 调优 2026-05-26（B2）— 仅当 tool_repeat_fail.count >= 5 / no_progress.rounds >= 6 /
    //                       user_force_takeover 这种「强信号」才允许跳出 cooldown；
    //                       低于阈值的同名信号仍保持 cooldown。
    const decision = supervisor.evaluate(ctxWith({
      round: 6,
      signals: [{ type: 'tool_repeat_fail', count: 4 }],
      riskScore: 0.95,
    }));
    expect(decision).toEqual({ action: 'continue' });
    expect(supervisor.getPhase()).toBe('cooldown');
  });

  it('breaks cooldown and re-enters takeover when a strong signal arrives (B2)', () => {
    const supervisor = makeAndEnterTakeover();
    supervisor.evaluate(ctxWith({ round: 2, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 3, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 4, signals: [] }));
    supervisor.evaluate(ctxWith({ round: 5, signals: [] }));
    expect(supervisor.getPhase()).toBe('cooldown');

    const decision = supervisor.evaluate(ctxWith({
      round: 6,
      signals: [{ type: 'tool_repeat_fail', count: 5 }],
      riskScore: 0.95,
    }));
    expect(decision.action).toBe('takeover');
    expect(supervisor.getPhase()).toBe('takeover');
  });
});

describe('RecoverySupervisor - computeNext (dry-run)', () => {
  it('does not mutate internal snapshot when commit is not called', () => {
    const supervisor = new RecoverySupervisor(params);
    const before = supervisor.getSnapshot();

    const { decision, nextSnapshot } = supervisor.computeNext(ctxWith({
      riskScore: 0.7,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
    }));

    expect(decision.action).toBe('takeover');
    expect(nextSnapshot.phase).toBe('takeover');
    expect(supervisor.getSnapshot()).toEqual(before);
    expect(supervisor.getPhase()).toBe('free');
  });

  it('commit explicitly advances snapshot', () => {
    const supervisor = new RecoverySupervisor(params);
    const { nextSnapshot } = supervisor.computeNext(ctxWith({
      riskScore: 0.7,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
    }));
    supervisor.commit(nextSnapshot);
    expect(supervisor.getPhase()).toBe('takeover');
  });
});

describe('RecoverySupervisor - applyTakeover / CorrectionPort', () => {
  it('injects a takeover block via CorrectionPort with phase=takeover (escapes W7)', () => {
    const supervisor = new RecoverySupervisor(params);
    const messages: UnifiedMessage[] = [];
    const port = new MessageCorrectionPort(messages);

    // Move into takeover first (simulates bridge.commit).
    supervisor.evaluate(ctxWith({
      riskScore: 0.7,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
    }));

    supervisor.applyTakeover({
      round: 2,
      reason: 'tool_repeat_fail:3',
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
      task: makeTask(),
      correctionPort: port,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('[System Recovery]');
    expect(messages[0].content).toContain('tool_repeat_fail:3');
  });

  it('applyHandoff is no-op when no correctionPort is supplied', () => {
    const supervisor = new RecoverySupervisor(params);
    expect(() => supervisor.applyHandoff({ round: 1, task: makeTask() })).not.toThrow();
  });

  it('调优 C: applyTakeover 携带 evidence 时输出失败签名 / 验收 / 后台行', () => {
    const supervisor = new RecoverySupervisor(params);
    const messages: UnifiedMessage[] = [];
    const port = new MessageCorrectionPort(messages);

    supervisor.evaluate(ctxWith({
      riskScore: 0.7,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
    }));

    supervisor.applyTakeover({
      round: 2,
      reason: 'tool_repeat_fail:3',
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
      task: makeTask(),
      correctionPort: port,
      evidence: {
        recentFailedSignatures: ['run_command:npm test (x4)', 'run_command:vitest (x3)'],
        pendingAcceptanceCommands: ['npm test', 'npm run e2e'],
        runningBackgroundTasks: ['npm test 2>&1 (running 3m)'],
      },
    });

    const content = messages[0].content as string;
    expect(content).toContain('[System Recovery]');
    expect(content).toContain('Repeated failing tool calls: run_command:npm test (x4) | run_command:vitest (x3)');
    expect(content).toContain('Acceptance pending: npm test, npm run e2e');
    expect(content).toContain('Background tasks: npm test 2>&1 (running 3m)');
    expect(content).toContain('Do NOT retry the failing tool with the same arguments.');
  });

  it('调优 C: evidence 缺省时退回原始文案（向后兼容）', () => {
    const supervisor = new RecoverySupervisor(params);
    const messages: UnifiedMessage[] = [];
    const port = new MessageCorrectionPort(messages);

    supervisor.evaluate(ctxWith({
      riskScore: 0.7,
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
    }));

    supervisor.applyTakeover({
      round: 2,
      reason: 'tool_repeat_fail:3',
      signals: [{ type: 'tool_repeat_fail', count: 3 }],
      task: makeTask(),
      correctionPort: port,
    });

    const content = messages[0].content as string;
    expect(content).toContain('[System Recovery]');
    expect(content).not.toContain('Repeated failing tool calls:');
    expect(content).not.toContain('Acceptance pending:');
    expect(content).not.toContain('Background tasks:');
  });
});

describe('formatTakeoverReason', () => {
  it('joins multiple signals with commas', () => {
    expect(formatTakeoverReason([
      { type: 'tool_repeat_fail', count: 3 },
      { type: 'no_progress', rounds: 4 },
    ])).toBe('tool_repeat_fail:3,no_progress:4');
  });

  it('returns "takeover" when signals are empty', () => {
    expect(formatTakeoverReason([])).toBe('takeover');
  });
});
