/**
 * TaskGraph Edge Cases — 边界条件 + 加固测试
 *
 * Phase 9 Hardening：验证所有组件在异常输入下不崩溃、返回值合法。
 */

import { describe, it, expect } from 'vitest';
import { createTaskGraph, getCurrentNode, advanceCursor, toSnapshot, applySnapshot, compactGraph, markGraphDone, hasPendingNodes, switchToFallbackBranch } from '../src/harness/task-graph.js';
import { buildGraph } from '../src/harness/task-graph-builder.js';
import { FailureClassifier, ContractValidator, DeviationDetector, EscalationManager } from '../src/harness/task-graph-review.js';
import { GraphExecutor } from '../src/harness/task-graph-executor.js';
import { parsePersistedTaskGraph, deserializeGraphSnapshot, buildGraphFence, parseGraphFence } from '../src/harness/task-graph-persistence.js';
import type { NodeContract, TaskGraphSnapshot } from '../src/types/task-graph.js';
import { TASK_GRAPH_SCHEMA_VERSION } from '../src/types/task-graph.js';

// ═══════════════════════════════════════════════
// TaskGraph Core — 空/无效输入
// ═══════════════════════════════════════════════

describe('Edge: createTaskGraph', () => {
  it('空 nodes 不崩溃', () => {
    const g = createTaskGraph({ goal: 'test', intent: 'edit', nodes: [] });
    expect(g).toBeTruthy();
    expect(getCurrentNode(g)).toBeUndefined();
  });

  it('cursor.nodeId 不存在时 getCurrentNode 返回 undefined', () => {
    const g = createTaskGraph({ goal: 'test', intent: 'edit', nodes: [] });
    g.cursor.nodeId = 'nonexistent';
    expect(getCurrentNode(g)).toBeUndefined();
  });

  it('advanceCursor 在空分支返回 undefined', () => {
    const g = createTaskGraph({ goal: 'test', intent: 'edit', nodes: [] });
    expect(advanceCursor(g)).toBeUndefined();
  });

  it('空 goal 不崩溃', () => {
    const g = createTaskGraph({ goal: '', intent: 'edit', nodes: [] });
    expect(g.goal).toBe('');
    expect(g.status).toBe('ready');
  });
});

// ═══════════════════════════════════════════════
// Fallback — 耗尽
// ═══════════════════════════════════════════════

describe('Edge: switchToFallbackBranch', () => {
  it('无 fallback 分支返回 null', () => {
    const g = createTaskGraph({
      goal: 'test', intent: 'edit',
      nodes: [
        { id: 'n1', type: 'edit', title: 'E', phase: 'editing', requiresTool: true, status: 'pending', retryCount: 0, maxRetries: 2 },
      ],
    });
    expect(switchToFallbackBranch(g, 'retries_exceeded')).toBeNull();
  });

  it('fallback 耗尽返回 null', () => {
    const g = createTaskGraph({
      goal: 'test', intent: 'edit',
      nodes: [
        { id: 'n1', type: 'edit', title: 'E', phase: 'editing', requiresTool: true, status: 'pending', retryCount: 0, maxRetries: 2 },
        { id: 'fb1', type: 'fallback', title: 'F', phase: 'editing', requiresTool: true, status: 'pending', retryCount: 0, maxRetries: 1 },
      ],
    });
    expect(switchToFallbackBranch(g, 'retries_exceeded')).toBeTruthy();
    expect(switchToFallbackBranch(g, 'retries_exceeded')).toBeNull();
  });
});

// ═══════════════════════════════════════════════
// Snapshot — 边界
// ═══════════════════════════════════════════════

describe('Edge: Snapshot', () => {
  it('空 nodes 快照往返', () => {
    const g = createTaskGraph({ goal: 'test', intent: 'edit', nodes: [] });
    const snap = toSnapshot(g);
    expect(snap.nodes).toEqual({});
    applySnapshot(g, snap);
    expect(g.status).toBe('ready');
  });

  it('旧版本快照不报错', () => {
    const snap: TaskGraphSnapshot = {
      version: 0 as any,
      graphId: 'old',
      goal: 'old', intent: 'edit', status: 'done', progress: 100,
      cursor: { branchId: 'b', nodeId: '', nodeIndex: 0, completedNodeIds: [], skippedNodeIds: [] },
      nodes: {}, nodeHistory: [], branchHistory: [], updatedAt: 0,
    };
    const g = createTaskGraph({ goal: 'test', intent: 'edit', nodes: [] });
    expect(() => applySnapshot(g, snap)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════
// Compaction — 超大历史
// ═══════════════════════════════════════════════

describe('Edge: Compaction', () => {
  it('超 1000 条 nodeHistory 截断', () => {
    const g = createTaskGraph({
      goal: 'test', intent: 'edit',
      nodes: [{ id: 'n1', type: 'edit', title: 'E', phase: 'editing', requiresTool: true, status: 'done', retryCount: 0, maxRetries: 2 }],
    });
    for (let i = 0; i < 1200; i++) {
      g.nodeHistory.push({ nodeId: 'n1', status: 'done', startedAt: i, endedAt: i + 1, retries: 0 });
    }
    compactGraph(g, { maxNodeHistoryEntries: 100, maxBranchHistoryEntries: 20, compactErrors: true, pruneDeadFallbacks: true });
    expect(g.nodeHistory.length).toBeLessThanOrEqual(100);
  });
});

// ═══════════════════════════════════════════════
// Builder — 未知 intent
// ═══════════════════════════════════════════════

describe('Edge: Builder unknown intent', () => {
  it('未知 intent "deploy" 不崩溃', () => {
    const g = buildGraph({ goal: '部署', intent: 'deploy' as any });
    expect(g).toBeTruthy();
    expect(g.nodes).toBeDefined();
  });
});

// ═══════════════════════════════════════════════
// FailureClassifier — 全覆盖
// ═══════════════════════════════════════════════

describe('Edge: FailureClassifier 全覆盖', () => {
  const fc = new FailureClassifier();

  const cases: Array<[string, string | undefined, string, string]> = [
    ['ENOENT: no such file', 'read_file', 'hallucinated_path', 'file_not_found'],
    ['ENOENT: no such file', 'write_file', 'tool_error', 'file_not_found'],
    ['EACCES: permission denied', 'write_file', 'permission_denied', 'file_permission'],
    ['syntax error: unexpected token', 'edit_file', 'tool_error', 'syntax_error'],
    ['1 test failed: assertion not met', undefined, 'verification_fail', 'test_failed'],
    ['tsc error: type mismatch', undefined, 'verification_fail', 'type_error'],
    ['cannot find module', undefined, 'verification_fail', 'type_error'],
    ['contract violation: forbidden tool called', undefined, 'contract_violation', 'forbidden_tool_call'],
    ['all fallback branches exhausted', undefined, 'branch_exhausted', 'no_fallback_remaining'],
    ['operation timed out after 30s', undefined, 'timeout', 'operation_timeout'],
    ['context length exceeds max token limit', undefined, 'token_exhausted', 'context_limit'],
    ['something weird happened', undefined, 'tool_error', 'unknown'],
  ];

  for (const [error, toolName, expectedCat, expectedSub] of cases) {
    it(`${expectedCat}/${expectedSub}`, () => {
      const f = fc.classify(error, toolName);
      expect(f.category).toBe(expectedCat);
      expect(f.subType).toBe(expectedSub);
    });
  }

  it('空 error → unknown', () => {
    const f = fc.classify('');
    expect(f.category).toBe('tool_error');
    expect(f.subType).toBe('unknown');
  });

  it('超长 error 不崩溃', () => {
    const long = 'x'.repeat(5000);
    const f = fc.classify(long);
    expect(f.category).toBe('tool_error');
  });
});

// ═══════════════════════════════════════════════
// ContractValidator — 空合约
// ═══════════════════════════════════════════════

describe('Edge: ContractValidator', () => {
  const emptyContract: NodeContract = {
    nodeId: 'n1', allowedTools: [], forbiddenTools: [], preferredTools: [],
    requiredOutputSignals: [],
    completionCriteria: { requiredSignals: [], minToolCalls: 0, maxRounds: 10, allowExplicitDone: false },
    nodeGuard: { maxIdleRounds: 3, maxToolsPerRound: 5, maxSameToolRepeat: 5, enforceToolBoundary: false, deviationTolerance: 'soft' },
    version: 1,
  };

  it('空 allowedTools 不拦截任意工具', () => {
    const cv = new ContractValidator(emptyContract);
    expect(cv.checkBeforeToolCall('any_tool').action).toBe('allow');
  });

  it('空 requiredSignals 立即完成', () => {
    const cv = new ContractValidator(emptyContract);
    expect(cv.checkCompletion().completed).toBe(true);
  });
});

// ═══════════════════════════════════════════════
// EscalationManager — 极值
// ═══════════════════════════════════════════════

describe('Edge: EscalationManager', () => {
  it('连续 evaluate 10 次 soft 偏离不崩溃', () => {
    const em = new EscalationManager();
    for (let i = 0; i < 10; i++) {
      expect(() => em.evaluate('soft', 'n1')).not.toThrow();
    }
  });

  it('deescalate 在 L0 不崩溃', () => {
    const em = new EscalationManager();
    expect(() => em.deescalate()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════
// Persistence — 损坏数据
// ═══════════════════════════════════════════════

describe('Edge: Persistence', () => {
  it('损坏 JSON → null', () => {
    expect(deserializeGraphSnapshot('{broken')).toBeNull();
  });

  it('空 fence → null', () => {
    expect(parseGraphFence('')).toBeNull();
  });

  it('parsePersistedTaskGraph 损坏笔记 → 全 null', () => {
    const r = parsePersistedTaskGraph('random text without any fence block');
    expect(r.graph).toBeNull();
    expect(r.metrics).toBeNull();
    expect(r.debug).toBeNull();
  });

  it('空 fence 内容 → null', () => {
    const fence = '```icecoder-graph\n\n```';
    expect(parseGraphFence(fence)).toBeNull();
  });
});

// ═══════════════════════════════════════════════
// GraphExecutor — 并发任务切换
// ═══════════════════════════════════════════════

describe('Edge: GraphExecutor 并发', () => {
  it('快速连续 initGraph 不崩溃', () => {
    const ex = new GraphExecutor();
    ex.initGraph({ goal: 'task1', intent: 'edit' });
    ex.initGraph({ goal: 'task2', intent: 'debug' });
    expect(ex.hasGraph()).toBe(true);
  });

  it('resetGraph 后 checkToolCall 不崩溃', () => {
    const ex = new GraphExecutor();
    ex.initGraph({ goal: 'test', intent: 'edit' });
    ex.resetGraph();
    expect(ex.checkToolCall('read_file').action).toBe('allow');
  });
});

// ═══════════════════════════════════════════════
// DeviationDetector — 空输入
// ═══════════════════════════════════════════════

describe('Edge: DeviationDetector', () => {
  it('空 toolNames 不崩溃', () => {
    const dd = new DeviationDetector();
    const r = dd.detect({
      toolNames: [],
      allowedTools: ['read_file'],
      nodePhase: 'context',
      nodeGuard: { maxSameToolRepeat: 3 },
    });
    // 空 toolNames + 有 allowedTools → tool_mismatch（符合预期）
    expect(r.deviated).toBe(true);
    expect(r.type).toBe('tool_mismatch');
  });
});
