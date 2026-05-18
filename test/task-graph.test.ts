/**
 * TaskGraph Runtime Core — 单元测试
 *
 * 覆盖：create / cursor / branch / snapshot / compaction / recovery / session
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { TaskNode, TaskEdge } from '../src/types/task-graph.js';
import { emptyTaskGraphSnapshot } from '../src/types/task-graph.js';
import {
  createTaskGraph,
  getCurrentNode,
  getNode,
  getCurrentBranchNodes,
  getMainBranchNodes,
  getFallbackBranchNodes,
  findNodesByType,
  hasPendingNodes,
  advanceCursor,
  startCurrentNode,
  completeCurrentNode,
  skipCurrentNode,
  incrementRetry,
  switchToFallbackBranch,
  hasAvailableFallback,
  getCurrentBranchId,
  markGraphDone,
  markGraphFailed,
  markGraphPaused,
  toSnapshot,
  applySnapshot,
  needsRecovery,
  compactGraph,
  createGraphSession,
  transitionSession,
  findActiveSession,
  getSession,
  clearSession,
} from '../src/harness/task-graph.js';

// ─── Helpers ───

function makeNode(id: string, type: TaskNode['type'], title: string, overrides?: Partial<TaskNode>): TaskNode {
  return {
    id,
    type,
    title,
    phase: type === 'inspect' || type === 'search' || type === 'read' ? 'context'
      : type === 'edit' ? 'editing'
      : type === 'verify' ? 'verification'
      : type === 'summarize' ? 'final'
      : 'intent',
    requiresTool: type !== 'summarize',
    status: 'pending',
    retryCount: 0,
    maxRetries: 2,
    ...overrides,
  };
}

let tick = 0;
function mockNow() {
  return 1000 + (++tick) * 100;
}

// ═══════════════════════════════════════════════

describe('createTaskGraph', () => {
  it('构建标准 5 节点图', () => {
    const nodes: TaskNode[] = [
      makeNode('node-01', 'inspect', '理解目标'),
      makeNode('node-02', 'search', '查阅相关内容'),
      makeNode('node-03', 'edit', '编写代码'),
      makeNode('node-04', 'verify', '运行验证'),
      makeNode('node-05', 'summarize', '总结变更'),
    ];

    const graph = createTaskGraph({ goal: '修复bug', intent: 'debug', nodes, now: mockNow, graphId: 'g1' });

    expect(graph.graphId).toBe('g1');
    expect(graph.goal).toBe('修复bug');
    expect(graph.intent).toBe('debug');
    expect(graph.status).toBe('ready');
    expect(graph.progress).toBe(0);
    expect(Object.keys(graph.nodes)).toHaveLength(5);
    expect(graph.mainBranch.nodeIds).toEqual(['node-01', 'node-02', 'node-03', 'node-04', 'node-05']);
    expect(graph.cursor.nodeId).toBe('node-01');
    expect(graph.cursor.nodeIndex).toBe(0);
    expect(graph.cursor.branchId).toBe(graph.mainBranch.id);
  });

  it('区分主节点和 fallback 节点', () => {
    const nodes: TaskNode[] = [
      makeNode('node-01', 'inspect', '理解'),
      makeNode('node-02', 'edit', '编辑'),
      makeNode('fb-01', 'fallback', '后备方案'),
    ];

    const graph = createTaskGraph({ goal: 'edit', intent: 'edit', nodes, now: mockNow, graphId: 'g2' });

    expect(graph.mainBranch.nodeIds).toEqual(['node-01', 'node-02']);
    expect(graph.fallbackBranches).toHaveLength(1);
    expect(graph.fallbackBranches[0].nodeIds).toEqual(['fb-01']);
  });

  it('空 nodes 不崩溃', () => {
    const graph = createTaskGraph({ goal: '', intent: 'question', nodes: [], now: mockNow, graphId: 'g3' });
    expect(Object.keys(graph.nodes)).toHaveLength(0);
    expect(graph.mainBranch.nodeIds).toEqual([]);
    expect(graph.cursor.nodeId).toBe('');
  });
});

// ═══════════════════════════════════════════════

describe('Node Operations', () => {
  let graph: ReturnType<typeof createTaskGraph>;

  beforeEach(() => {
    tick = 0;
    graph = createTaskGraph({
      goal: 'test', intent: 'edit', graphId: 'g-n',
      nodes: [
        makeNode('n1', 'inspect', 'A'),
        makeNode('n2', 'edit', 'B'),
        makeNode('n3', 'verify', 'C'),
      ],
      now: mockNow,
    });
  });

  it('getCurrentNode 返回游标节点', () => {
    const n = getCurrentNode(graph);
    expect(n?.id).toBe('n1');
  });

  it('getCurrentNode 在无效 cursor 时返回 undefined', () => {
    graph.cursor.nodeId = 'nonexistent';
    expect(getCurrentNode(graph)).toBeUndefined();
  });

  it('getNode 按 ID 查询', () => {
    expect(getNode(graph, 'n2')?.title).toBe('B');
    expect(getNode(graph, 'n99')).toBeUndefined();
  });

  it('getCurrentBranchNodes 返回当前分支节点', () => {
    const nodes = getCurrentBranchNodes(graph);
    expect(nodes.map(n => n.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('getMainBranchNodes 排除 fallback', () => {
    const g2 = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-m', now: mockNow,
      nodes: [
        makeNode('m1', 'inspect', 'X'),
        makeNode('m2', 'fallback', 'F'),
      ],
    });
    expect(getMainBranchNodes(g2).map(n => n.id)).toEqual(['m1']);
  });

  it('getFallbackBranchNodes 仅返回 fallback 节点', () => {
    const nodes = getFallbackBranchNodes(graph);
    expect(nodes).toHaveLength(0);

    const g2 = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-fb', now: mockNow,
      nodes: [
        makeNode('a', 'inspect', 'A'),
        makeNode('b', 'fallback', 'FB'),
      ],
    });
    expect(getFallbackBranchNodes(g2).map(n => n.id)).toEqual(['b']);
  });

  it('findNodesByType', () => {
    expect(findNodesByType(graph, 'edit')).toHaveLength(1);
    expect(findNodesByType(graph, 'fallback')).toHaveLength(0);
  });

  it('hasPendingNodes', () => {
    expect(hasPendingNodes(graph)).toBe(true);
    // complete all
    for (const _ of graph.mainBranch.nodeIds) {
      startCurrentNode(graph);
      completeCurrentNode(graph);
      advanceCursor(graph);
    }
    expect(hasPendingNodes(graph)).toBe(false);
  });
});

// ═══════════════════════════════════════════════

describe('Cursor Operations', () => {
  let graph: ReturnType<typeof createTaskGraph>;

  beforeEach(() => {
    tick = 0;
    graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-c', now: mockNow,
      nodes: [
        makeNode('c1', 'inspect', 'Step 1'),
        makeNode('c2', 'edit', 'Step 2'),
        makeNode('c3', 'summarize', 'Step 3'),
      ],
    });
  });

  it('startCurrentNode → completeCurrentNode → advanceCursor 全流程', () => {
    // Node 1
    const n1 = startCurrentNode(graph);
    expect(n1?.status).toBe('running');
    expect(n1?.startedAt).toBeGreaterThan(0);
    expect(graph.status).toBe('running');

    completeCurrentNode(graph);
    const n1After = getNode(graph, 'c1')!;
    expect(n1After.status).toBe('done');
    expect(n1After.endedAt).toBeGreaterThan(0);
    expect(graph.nodeHistory).toHaveLength(1);
    expect(graph.nodeHistory[0].nodeId).toBe('c1');
    expect(graph.nodeHistory[0].status).toBe('done');

    // Advance
    const n2 = advanceCursor(graph);
    expect(n2?.id).toBe('c2');
    expect(graph.cursor.nodeIndex).toBe(1);

    // Node 2
    startCurrentNode(graph);
    completeCurrentNode(graph, 'something wrong');
    const n2After = getNode(graph, 'c2')!;
    expect(n2After.status).toBe('failed');
    expect(n2After.error).toBe('something wrong');
    expect(graph.nodeHistory).toHaveLength(2);
    expect(graph.nodeHistory[1].status).toBe('failed');

    // Advance to last
    advanceCursor(graph);
    expect(graph.cursor.nodeId).toBe('c3');

    // Advance past end
    startCurrentNode(graph);
    completeCurrentNode(graph);
    const over = advanceCursor(graph);
    expect(over).toBeUndefined();
    expect(graph.cursor.nodeIndex).toBe(2);
  });

  it('skipCurrentNode', () => {
    startCurrentNode(graph);
    skipCurrentNode(graph, 'not needed');
    const n = getNode(graph, 'c1')!;
    expect(n.status).toBe('skipped');
    expect(graph.cursor.skippedNodeIds).toContain('c1');
    expect(graph.nodeHistory[0].status).toBe('skipped');
  });

  it('incrementRetry 跟踪重试', () => {
    const node = getNode(graph, 'c1')!;
    node.maxRetries = 2;
    expect(incrementRetry(graph)).toBe(false); // 1 < 2
    expect(node.retryCount).toBe(1);
    expect(incrementRetry(graph)).toBe(true);  // 2 >= 2
    expect(node.retryCount).toBe(2);
  });

  it('advanceCursor 无更多节点返回 undefined', () => {
    startCurrentNode(graph); completeCurrentNode(graph); advanceCursor(graph);
    startCurrentNode(graph); completeCurrentNode(graph); advanceCursor(graph);
    startCurrentNode(graph); completeCurrentNode(graph);
    expect(advanceCursor(graph)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════

describe('Branch Operations', () => {
  it('switchToFallbackBranch 切换并消耗 attempt', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-br', now: mockNow,
      nodes: [
        makeNode('b1', 'inspect', 'Main'),
        makeNode('fb1', 'fallback', 'Fallback'),
      ],
    });

    expect(hasAvailableFallback(graph)).toBe(true);
    expect(graph.fallbackBranches[0].attemptCount).toBe(0);

    const cursor = switchToFallbackBranch(graph, 'retries_exceeded');
    expect(cursor).not.toBeNull();
    expect(cursor!.branchId).toBe(graph.fallbackBranches[0].id);
    expect(cursor!.nodeId).toBe('fb1');
    expect(graph.fallbackBranches[0].attemptCount).toBe(1);
    expect(graph.branchHistory).toHaveLength(1);
  });

  it('fallback 耗尽后返回 null', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-br2', now: mockNow,
      nodes: [
        makeNode('x1', 'inspect', 'X'),
        makeNode('fbx', 'fallback', 'FB'),
      ],
    });
    graph.fallbackBranches[0].maxAttempts = 1;

    switchToFallbackBranch(graph, 'no_progress');
    expect(hasAvailableFallback(graph)).toBe(false);
    expect(switchToFallbackBranch(graph, 'no_progress')).toBeNull();
  });

  it('getCurrentBranchId', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-br3', now: mockNow,
      nodes: [makeNode('z1', 'inspect', 'Z')],
    });
    expect(getCurrentBranchId(graph)).toBe(graph.mainBranch.id);
  });
});

// ═══════════════════════════════════════════════

describe('Status Operations', () => {
  it('markGraphDone', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-st', now: mockNow,
      nodes: [makeNode('s1', 'inspect', 'S')],
    });
    markGraphDone(graph);
    expect(graph.status).toBe('done');
    expect(graph.progress).toBe(100);
  });

  it('markGraphFailed', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-st2', now: mockNow,
      nodes: [makeNode('s2', 'edit', 'E')],
    });
    startCurrentNode(graph);
    markGraphFailed(graph, 'boom');
    expect(graph.status).toBe('failed');
    expect(getCurrentNode(graph)?.error).toBe('boom');
  });

  it('markGraphPaused', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-st3', now: mockNow,
      nodes: [makeNode('s3', 'inspect', 'P')],
    });
    markGraphPaused(graph);
    expect(graph.status).toBe('paused');
  });
});

// ═══════════════════════════════════════════════

describe('Snapshot', () => {
  it('toSnapshot → applySnapshot 往返', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 'snapshot test', intent: 'debug', graphId: 'g-snap', now: mockNow,
      nodes: [
        makeNode('sn1', 'inspect', 'A'),
        makeNode('sn2', 'edit', 'B'),
      ],
    });

    startCurrentNode(graph);
    completeCurrentNode(graph);
    advanceCursor(graph);
    startCurrentNode(graph);

    const snap = toSnapshot(graph);
    expect(snap.graphId).toBe('g-snap');
    expect(snap.status).toBe('running');
    expect(snap.cursor.nodeId).toBe('sn2');
    expect(snap.nodes['sn1'].status).toBe('done');
    expect(snap.nodes['sn2'].status).toBe('running');

    // 重建 + 恢复
    tick = 0;
    const graph2 = createTaskGraph({
      goal: 'snapshot test', intent: 'debug', graphId: 'g-snap', now: mockNow,
      nodes: [
        makeNode('sn1', 'inspect', 'A'),
        makeNode('sn2', 'edit', 'B'),
      ],
    });
    applySnapshot(graph2, snap);

    expect(graph2.status).toBe('running');
    expect(graph2.cursor.nodeId).toBe('sn2');
    expect(graph2.nodes['sn1'].status).toBe('done');
    expect(graph2.nodes['sn2'].status).toBe('running');
  });

  it('applySnapshot 处理未知节点', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-snap2', now: mockNow,
      nodes: [makeNode('a', 'inspect', 'A')],
    });

    const snap = emptyTaskGraphSnapshot();
    snap.nodes['nonexistent'] = { status: 'done', retryCount: 0 };

    applySnapshot(graph, snap); // 不应崩溃
  });
});

// ═══════════════════════════════════════════════

describe('Recovery', () => {
  it('needsRecovery 在重试耗尽时触发 fallback signal', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-rec', now: mockNow,
      nodes: [makeNode('r1', 'edit', 'Edit', { maxRetries: 1 })],
    });

    startCurrentNode(graph);
    completeCurrentNode(graph, 'fail');
    incrementRetry(graph); // retryCount=1 >= maxRetries=1

    const signal = needsRecovery(graph);
    expect(signal).not.toBeNull();
    expect(signal!.level).toBe('fallback');
    expect(signal!.nodeId).toBe('r1');
  });

  it('needsRecovery 在失败但未达重试上限时触发 retry signal', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-rec2', now: mockNow,
      nodes: [makeNode('r2', 'edit', 'Edit', { maxRetries: 3 })],
    });

    startCurrentNode(graph);
    completeCurrentNode(graph, 'minor fail');

    const signal = needsRecovery(graph);
    expect(signal).not.toBeNull();
    expect(signal!.level).toBe('retry');
  });

  it('needsRecovery 无失败时返回 null', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-rec3', now: mockNow,
      nodes: [makeNode('r3', 'edit', 'OK')],
    });
    startCurrentNode(graph);
    completeCurrentNode(graph);
    expect(needsRecovery(graph)).toBeNull();
  });
});

// ═══════════════════════════════════════════════

describe('CompactGraph', () => {
  it('截断超限 nodeHistory', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-compact', now: mockNow,
      nodes: [makeNode('co1', 'inspect', 'A'), makeNode('co2', 'edit', 'B')],
    });

    // 填充 60 条 nodeHistory
    for (let i = 0; i < 60; i++) {
      graph.nodeHistory.push({
        nodeId: `node-${i}`,
        status: 'done',
        startedAt: 1000 + i,
        endedAt: 1100 + i,
        retries: 0,
      });
    }

    compactGraph(graph, { maxNodeHistoryEntries: 10, maxBranchHistoryEntries: 5, compactErrors: true, pruneDeadFallbacks: true });
    // 保留最近 10 条
    expect(graph.nodeHistory.length).toBeLessThanOrEqual(11); // 10 recent + possible failed
  });

  it('剪枝已耗尽 fallback', () => {
    tick = 0;
    const graph = createTaskGraph({
      goal: 't', intent: 'edit', graphId: 'g-compact2', now: mockNow,
      nodes: [
        makeNode('cp1', 'inspect', 'A'),
        makeNode('cpfb', 'fallback', 'FB'),
      ],
    });
    graph.fallbackBranches[0].maxAttempts = 1;
    graph.fallbackBranches[0].attemptCount = 1;

    compactGraph(graph, { maxNodeHistoryEntries: 50, maxBranchHistoryEntries: 20, compactErrors: false, pruneDeadFallbacks: true });
    expect(graph.fallbackBranches).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════

describe('GraphSession', () => {
  it('create → transition → find', () => {
    const s = createGraphSession('g-sess1', 'task-1', 'fix bug', 0);
    expect(s.status).toBe('active');
    expect(s.graphId).toBe('g-sess1');

    const active = findActiveSession();
    expect(active?.graphId).toBe('g-sess1');

    transitionSession('g-sess1', 'completed');
    expect(getSession('g-sess1')?.status).toBe('completed');
    expect(findActiveSession()).toBeUndefined();
  });

  it('clearSession', () => {
    createGraphSession('g-sess2', 'task-2', 'refactor', 1);
    clearSession('g-sess2');
    expect(getSession('g-sess2')).toBeUndefined();
  });
});
