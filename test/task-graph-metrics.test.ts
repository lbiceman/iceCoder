/**
 * TaskGraph Metrics — 单元测试
 *
 * 覆盖：calcNodeScore / calcBranchEfficiency / calcSuccessConfidence / buildGraphMetrics / ReplayBuilder
 */

import { describe, it, expect } from 'vitest';
import {
  calcNodeScore,
  calcBranchEfficiency,
  calcSuccessConfidence,
  buildGraphMetrics,
  ReplayBuilder,
} from '../src/harness/task-graph-metrics.js';
import type { NodeMetrics, BranchMetrics, GraphMetrics } from '../src/types/task-graph.js';

// ═══════════════════════════════════════════════

function makeNode(overrides?: Partial<NodeMetrics>): NodeMetrics {
  return {
    nodeId: 'n1',
    nodeType: 'edit',
    roundsUsed: 3,
    toolCalls: 5,
    retries: 0,
    verificationScore: 0,
    success: true,
    signalCompletionRate: 1,
    idleRounds: 0,
    ...overrides,
  };
}

function makeBranch(overrides?: Partial<BranchMetrics>): BranchMetrics {
  return {
    branchId: 'b1',
    isFallback: false,
    nodeCount: 3,
    fallbackRate: 0,
    branchEfficiency: 100,
    recoveryCost: 0,
    branchDeadRatio: 0,
    avgNodeScore: 80,
    totalDuration: 10000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════

describe('calcNodeScore', () => {
  it('成功节点得高分', () => {
    const score = calcNodeScore(makeNode({ success: true, signalCompletionRate: 1, idleRounds: 0, retries: 0 }));
    expect(score).toBeGreaterThanOrEqual(90);
  });

  it('成功节点有重试扣分', () => {
    const perfect = calcNodeScore(makeNode({ success: true, retries: 0 }));
    const retried = calcNodeScore(makeNode({ success: true, retries: 2 }));
    expect(retried).toBeLessThan(perfect);
  });

  it('失败节点得分低', () => {
    const score = calcNodeScore(makeNode({ success: false, retries: 0 }));
    expect(score).toBeLessThanOrEqual(30);
  });

  it('失败 + 多次重试趋近 0', () => {
    const score = calcNodeScore(makeNode({ success: false, retries: 5 }));
    expect(score).toBe(0);
  });

  it('分数在 0-100 范围内', () => {
    const score = calcNodeScore(makeNode());
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ═══════════════════════════════════════════════

describe('calcBranchEfficiency', () => {
  it('直出 branchEfficiency', () => {
    expect(calcBranchEfficiency(makeBranch({ branchEfficiency: 85 }))).toBe(85);
  });

  it('边界裁剪', () => {
    expect(calcBranchEfficiency(makeBranch({ branchEfficiency: 150 }))).toBe(100);
    expect(calcBranchEfficiency(makeBranch({ branchEfficiency: -10 }))).toBe(0);
  });
});

// ═══════════════════════════════════════════════

describe('calcSuccessConfidence', () => {
  it('全满分图', () => {
    const m: GraphMetrics = {
      graphId: 'g1', goal: 'test', intent: 'edit',
      completionScore: 100, deterministicRatio: 1, recoverySuccessRate: 1,
      wastedSteps: 0, successConfidence: 0,
      nodeMetrics: [], branchMetrics: [],
      totalDuration: 1000, totalRounds: 5, totalToolCalls: 10,
      evaluatedAt: Date.now(),
    };
    const conf = calcSuccessConfidence(m);
    expect(conf).toBeCloseTo(1, 0);
  });

  it('全失败图', () => {
    const m: GraphMetrics = {
      graphId: 'g2', goal: 'test', intent: 'debug',
      completionScore: 0, deterministicRatio: 0, recoverySuccessRate: 0,
      wastedSteps: 5, successConfidence: 0,
      nodeMetrics: [], branchMetrics: [],
      totalDuration: 1000, totalRounds: 5, totalToolCalls: 10,
      evaluatedAt: Date.now(),
    };
    const conf = calcSuccessConfidence(m);
    expect(conf).toBe(0);
  });

  it('部分成功图', () => {
    const m: GraphMetrics = {
      graphId: 'g3', goal: 'test', intent: 'edit',
      completionScore: 50, deterministicRatio: 0.7, recoverySuccessRate: 0.5,
      wastedSteps: 2, successConfidence: 0,
      nodeMetrics: [], branchMetrics: [],
      totalDuration: 1000, totalRounds: 5, totalToolCalls: 10,
      evaluatedAt: Date.now(),
    };
    const conf = calcSuccessConfidence(m);
    expect(conf).toBeGreaterThan(0.3);
    expect(conf).toBeLessThan(0.7);
  });
});

// ═══════════════════════════════════════════════

describe('buildGraphMetrics', () => {
  it('计算 completionScore', () => {
    const g = buildGraphMetrics({
      graphId: 'g1', goal: 'test', intent: 'edit',
      nodeMetrics: [
        makeNode({ nodeId: 'n1', success: true }),
        makeNode({ nodeId: 'n2', success: true }),
        makeNode({ nodeId: 'n3', success: false }),
      ],
      branchMetrics: [makeBranch()],
      totalRounds: 10, totalToolCalls: 20, totalDuration: 5000,
    });
    expect(g.completionScore).toBe(67);
    expect(g.successConfidence).toBeGreaterThan(0.5);
    expect(g.wastedSteps).toBe(1);
  });
});

// ═══════════════════════════════════════════════

describe('ReplayBuilder', () => {
  it('build 空 checkpoint', () => {
    const trace = ReplayBuilder.build('g1', null, '');
    expect(trace.graphId).toBe('g1');
    expect(trace.toolReplays).toEqual([]);
    expect(trace.failureReplays).toEqual([]);
    expect(trace.replayType).toBe('full');
  });

  it('buildToolTrace 从 checkpoint 构建', () => {
    const checkpoint = {
      runtimeV2: {
        recentTools: [
          { name: 'read_file', at: 1000, success: true },
          { name: 'write_file', at: 2000, success: false },
        ],
      },
    };
    const tools = ReplayBuilder.buildToolTrace('g1', checkpoint);
    expect(tools).toHaveLength(2);
    expect(tools[0].toolName).toBe('read_file');
    expect(tools[0].success).toBe(true);
  });

  it('buildFailureTrace 从 checkpoint 构建', () => {
    const checkpoint = {
      runtimeV2: {
        recentFailures: [
          { signature: 'read_file:{}', lastError: 'ENOENT', at: 3000 },
        ],
      },
    };
    const failures = ReplayBuilder.buildFailureTrace('g1', checkpoint);
    expect(failures).toHaveLength(1);
    expect(failures[0].errorMessage).toBe('ENOENT');
  });
});
