/**
 * Node Contract Layer — 单元测试
 *
 * 覆盖：ContractValidator / DeviationDetector / FailureClassifier / EscalationManager / NodeCostTracker
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { NodeContract, NodeCostBudget } from '../src/types/task-graph.js';
import {
  ContractValidator,
  DeviationDetector,
  FailureClassifier,
  EscalationManager,
  NodeCostTrackerImpl,
} from '../src/harness/task-graph-review.js';

// ═══════════════════════════════════════════════

function makeContract(overrides?: Partial<NodeContract>): NodeContract {
  return {
    nodeId: 'node-01',
    allowedTools: ['read_file', 'glob', 'grep'],
    forbiddenTools: ['run_command'],
    preferredTools: ['read_file'],
    requiredOutputSignals: ['file_read'],
    completionCriteria: { requiredSignals: ['file_read'], minToolCalls: 1, maxRounds: 3, allowExplicitDone: false },
    nodeGuard: { maxIdleRounds: 2, maxToolsPerRound: 5, maxSameToolRepeat: 3, enforceToolBoundary: true, deviationTolerance: 'hard' },
    version: 1,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════

describe('ContractValidator', () => {
  let v: ContractValidator;

  beforeEach(() => { v = new ContractValidator(makeContract()); });

  it('allowedTools 通过', () => {
    expect(v.checkBeforeToolCall('read_file').action).toBe('allow');
  });

  it('forbiddenTools 拒绝', () => {
    const r = v.checkBeforeToolCall('run_command');
    expect(r.passed).toBe(false);
    expect(r.action).toBe('block');
    expect(r.violations[0].type).toBe('forbidden_tool');
  });

  it('不在白名单 + enforceToolBoundary=false → warn', () => {
    const v2 = new ContractValidator(makeContract({
      nodeGuard: { maxIdleRounds: 2, maxToolsPerRound: 5, maxSameToolRepeat: 3, enforceToolBoundary: false, deviationTolerance: 'hard' },
    }));
    const r = v2.checkBeforeToolCall('unknown_tool');
    expect(r.action).toBe('allow'); // 不拦截
  });

  it('连续同工具超限', () => {
    const c = makeContract({ nodeGuard: { maxIdleRounds: 2, maxToolsPerRound: 5, maxSameToolRepeat: 1, enforceToolBoundary: true, deviationTolerance: 'hard' } });
    const v2 = new ContractValidator(c);
    v2.checkBeforeToolCall('read_file');
    const r = v2.checkBeforeToolCall('read_file');
    expect(r.violations.some(x => x.type === 'repeat_tool')).toBe(true);
  });

  it('recordAfterToolCall 记录信号', () => {
    v.recordAfterToolCall('read_file', true, 'file_read');
    expect(v.checkCompletion().completed).toBe(true);
  });

  it('idle 超限', () => {
    v.checkRoundEnd(0);
    v.checkRoundEnd(0);
    const r = v.checkRoundEnd(0);
    expect(r.violations.some(x => x.type === 'idle_round')).toBe(true);
  });

  it('maxRounds 超限', () => {
    v.checkRoundEnd(1);
    v.checkRoundEnd(1);
    v.checkRoundEnd(1);
    const r = v.checkRoundEnd(1);
    expect(r.violations.some(x => x.type === 'round_exceeded')).toBe(true);
  });

  it('checkCompletion 缺少信号', () => {
    expect(v.checkCompletion().completed).toBe(false);
    v.recordAfterToolCall('read_file', true, 'file_read');
    expect(v.checkCompletion().completed).toBe(true);
  });

  it('reset 清除状态', () => {
    v.recordAfterToolCall('read_file', true, 'file_read');
    v.reset();
    expect(v.checkCompletion().completed).toBe(false);
  });
});

// ═══════════════════════════════════════════════

describe('DeviationDetector', () => {
  const dd = new DeviationDetector();

  it('tool_mismatch 检测', () => {
    const r = dd.detect({
      toolNames: ['run_command', 'write_file'],
      allowedTools: ['read_file', 'glob', 'grep'],
      nodePhase: 'context',
      nodeGuard: { maxSameToolRepeat: 3 },
    });
    expect(r.deviated).toBe(true);
    expect(r.type).toBe('tool_mismatch');
  });

  it('phase_mismatch 检测', () => {
    const r = dd.detect({
      toolNames: ['write_file'],
      allowedTools: ['write_file'],
      nodePhase: 'context',
      nodeGuard: { maxSameToolRepeat: 3 },
    });
    expect(r.deviated).toBe(true);
    expect(r.type).toBe('phase_mismatch');
  });

  it('scope_creep 检测', () => {
    const r = dd.detect({
      toolNames: ['read_file', 'grep', 'read_file', 'fs_operation'],
      allowedTools: ['write_file', 'read_file'],
      nodePhase: 'editing',
      nodeGuard: { maxSameToolRepeat: 2 },
    });
    expect(r.deviated).toBe(true);
    expect(r.type).toBe('scope_creep');
  });

  it('无偏离', () => {
    const r = dd.detect({
      toolNames: ['read_file'],
      allowedTools: ['read_file', 'glob', 'grep'],
      nodePhase: 'context',
      nodeGuard: { maxSameToolRepeat: 3 },
    });
    expect(r.deviated).toBe(false);
  });
});

// ═══════════════════════════════════════════════

describe('FailureClassifier', () => {
  const fc = new FailureClassifier();

  it('tool_error / file_not_found', () => {
    // read_file + enoent → hallucinated_path (检查顺序优先)
    const f = fc.classify('ENOENT: no such file', 'read_file');
    expect(f.category).toBe('hallucinated_path');
    expect(f.subType).toBe('file_not_found');
    expect(f.severity).toBe('recoverable');
  });

  it('tool_error / file_not_found (非 read_file)', () => {
    const f = fc.classify('ENOENT: no such file', 'write_file');
    expect(f.category).toBe('tool_error');
    expect(f.subType).toBe('file_not_found');
    expect(f.severity).toBe('recoverable');
  });

  it('permission_denied', () => {
    const f = fc.classify('EACCES: permission denied', 'write_file');
    expect(f.category).toBe('permission_denied');
    expect(f.suggestedRecovery.strategy).toBe('alternative_tool');
  });

  it('verification_fail / test_failed', () => {
    const f = fc.classify('1 test failed: assertion error');
    expect(f.category).toBe('verification_fail');
    expect(f.subType).toBe('test_failed');
  });

  it('verification_fail / type_error', () => {
    const f = fc.classify('tsc error: type string is not assignable');
    expect(f.category).toBe('verification_fail');
    expect(f.subType).toBe('type_error');
  });

  it('context_missing', () => {
    const f = fc.classify('cannot find the function', undefined, { filesRead: [] });
    expect(f.category).toBe('context_missing');
  });

  it('contract_violation', () => {
    const f = fc.classify('contract violation: forbidden tool called');
    expect(f.category).toBe('contract_violation');
  });

  it('hallucinated_path', () => {
    const f = fc.classify('ENOENT: file not found', 'read_file');
    expect(f.category).toBe('hallucinated_path');
  });

  it('branch_exhausted → fatal', () => {
    const f = fc.classify('all fallback branches exhausted');
    expect(f.category).toBe('branch_exhausted');
    expect(f.severity).toBe('fatal');
    expect(f.suggestedRecovery.strategy).toBe('ask_user');
  });

  it('timeout', () => {
    const f = fc.classify('operation timed out after 30 seconds');
    expect(f.category).toBe('timeout');
  });

  it('token_exhausted', () => {
    const f = fc.classify('context length exceeds max token limit');
    expect(f.category).toBe('token_exhausted');
  });

  it('unknown → fallback', () => {
    const f = fc.classify('something weird happened');
    expect(f.category).toBe('tool_error');
    expect(f.subType).toBe('unknown');
    expect(f.severity).toBe('recoverable');
  });
});

// ═══════════════════════════════════════════════

describe('EscalationManager', () => {
  let em: EscalationManager;

  beforeEach(() => { em = new EscalationManager(); });

  it('连续 soft 偏离升级到 L1', () => {
    em.evaluate('soft', 'n1');
    const r = em.evaluate('soft', 'n1');
    expect(em.policy.currentLevel).toBe(1);
  });

  it('hard 偏离直接 L1', () => {
    const r = em.evaluate('hard', 'n1');
    expect(em.policy.currentLevel).toBe(1);
  });

  it('critical 偏离直接 L3', () => {
    const r = em.evaluate('critical', 'n1');
    expect(r.action).toBe('force_switch');
    expect(em.policy.currentLevel).toBe(3);
  });

  it('升级链路：L1→L2→L3', () => {
    em.evaluate('hard', 'n1');           // L1
    em.evaluate('hard', 'n1');           // L1 → correction attempt
    const r = em.evaluate('hard', 'n1'); // L2
    expect(em.policy.currentLevel).toBeGreaterThanOrEqual(2);
    expect(r.action).toBe('block');
  });

  it('deescalate 降级', () => {
    em.evaluate('hard', 'n1');
    expect(em.policy.currentLevel).toBe(1);
    em.deescalate();
    expect(em.policy.currentLevel).toBe(0);
  });

  it('reset 完全重置', () => {
    em.evaluate('critical', 'n1');
    em.reset();
    expect(em.policy.currentLevel).toBe(0);
    expect(em.policy.history).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════

describe('NodeCostTracker', () => {
  const budget: NodeCostBudget = {
    maxTokens: 1000, maxRounds: 3, maxToolCalls: 5, maxToolOutputChars: 8000, maxDurationMs: 60000,
  };

  it('token 超限', () => {
    const t = new NodeCostTrackerImpl(budget);
    t.addTokens(1200);
    expect(t.isExhausted()).toBe(true);
    expect(t.exhaustedBy).toBe('tokens');
  });

  it('轮次超限', () => {
    const t = new NodeCostTrackerImpl(budget);
    t.addRound(2);
    t.addRound(2);
    t.addRound(2);
    t.addRound(2);
    expect(t.isExhausted()).toBe(true);
    expect(t.exhaustedBy).toBe('rounds');
  });

  it('工具调用超限', () => {
    const t = new NodeCostTrackerImpl(budget);
    t.addRound(6);
    expect(t.isExhausted()).toBe(true);
    expect(t.exhaustedBy).toBe('tool_calls');
  });

  it('utilizationRate 计算', () => {
    const t = new NodeCostTrackerImpl(budget);
    t.addTokens(500);
    expect(t.utilizationRate).toBeCloseTo(0.5, 1);
  });

  it('未超限', () => {
    const t = new NodeCostTrackerImpl(budget);
    t.addTokens(100);
    t.addRound(1);
    expect(t.isExhausted()).toBe(false);
  });
});
