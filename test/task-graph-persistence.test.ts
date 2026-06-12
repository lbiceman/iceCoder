/**
 * TaskGraph Persistence — 单元测试
 *
 * 覆盖：serialize / parse fence / CombinedCheckpointFile 向后兼容
 */

import { describe, it, expect } from 'vitest';
import {
  serializeGraphSnapshot,
  deserializeGraphSnapshot,
  buildGraphFence,
  buildMetricsFence,
  buildDebugFence,
  parseGraphFence,
  parseMetricsFence,
  parseDebugFence,
  parsePersistedTaskGraph,
  ICECODER_GRAPH_FENCE_LANG,
  ICECODER_METRICS_FENCE_LANG,
  ICECODER_DEBUG_FENCE_LANG,
} from '../src/harness/task-graph-persistence.js';
import { TASK_GRAPH_SCHEMA_VERSION } from '../src/types/task-graph.js';
import type { TaskGraphSnapshot, GraphMetrics, GraphDebugDump } from '../src/types/task-graph.js';

// ═══════════════════════════════════════════════

function makeSnapshot(overrides?: Partial<TaskGraphSnapshot>): TaskGraphSnapshot {
  return {
    version: TASK_GRAPH_SCHEMA_VERSION,
    graphId: 'g-test',
    goal: '修复登录bug',
    intent: 'edit',
    status: 'running',
    progress: 50,
    cursor: {
      branchId: 'branch-main-g-test',
      nodeId: 'node-01',
      nodeIndex: 0,
      completedNodeIds: [],
      skippedNodeIds: [],
    },
    nodes: {
      'node-01': { status: 'in_progress', retryCount: 0 },
    },
    nodeHistory: [],
    branchHistory: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════

describe('serialize / deserialize', () => {
  it('往返：序列化后反序列化一致', () => {
    const snap = makeSnapshot();
    const json = serializeGraphSnapshot(snap);
    const restored = deserializeGraphSnapshot(json);
    expect(restored).toBeTruthy();
    expect(restored!.graphId).toBe('g-test');
    expect(restored!.goal).toBe('修复登录bug');
    expect(restored!.intent).toBe('edit');
  });

  it('无效 JSON → null', () => {
    expect(deserializeGraphSnapshot('not json')).toBeNull();
  });

  it('错误 version → null', () => {
    const bad = makeSnapshot({ version: 99 } as any);
    expect(deserializeGraphSnapshot(JSON.stringify(bad))).toBeNull();
  });
});

// ═══════════════════════════════════════════════

describe('fence builders', () => {
  it('buildGraphFence 生成正确格式', () => {
    const snap = makeSnapshot();
    const fence = buildGraphFence(snap);
    expect(fence).toContain('```' + ICECODER_GRAPH_FENCE_LANG);
    expect(fence).toContain('"graphId": "g-test"');
    expect(fence).toContain('```');
  });

  it('buildMetricsFence 生成正确格式', () => {
    const metrics: GraphMetrics = {
      graphId: 'g-test',
      totalNodes: 4,
      completedNodes: 2,
      failedNodes: 0,
      skippedNodes: 0,
      fallbackActivations: 0,
      totalRounds: 10,
      totalToolCalls: 25,
      totalTokens: 50000,
      elapsedMs: 60000,
    };
    const fence = buildMetricsFence(metrics);
    expect(fence).toContain('```' + ICECODER_METRICS_FENCE_LANG);
    expect(fence).toContain('"totalNodes": 4');
  });

  it('buildDebugFence 生成正确格式', () => {
    const dump: GraphDebugDump = {
      graphId: 'g-test',
      at: Date.now(),
      trigger: 'node_done',
      graphSnapshot: makeSnapshot(),
      activeNode: { id: 'node-01', status: 'in_progress', retryCount: 0 },
      metrics: { graphId: 'g-test', totalNodes: 4, completedNodes: 2, failedNodes: 0, skippedNodes: 0, fallbackActivations: 0, totalRounds: 10, totalToolCalls: 25, totalTokens: 50000, elapsedMs: 60000 },
    };
    const fence = buildDebugFence(dump);
    expect(fence).toContain('```' + ICECODER_DEBUG_FENCE_LANG);
    expect(fence).toContain('"graphId": "g-test"');
  });
});

// ═══════════════════════════════════════════════

describe('fence parsers', () => {
  it('parseGraphFence 解析有效 fence', () => {
    const snap = makeSnapshot();
    const notes = 'some notes\n\n' + buildGraphFence(snap) + '\n\nmore notes';
    const parsed = parseGraphFence(notes);
    expect(parsed).toBeTruthy();
    expect(parsed!.graphId).toBe('g-test');
  });

  it('parseGraphFence 无 fence → null', () => {
    expect(parseGraphFence('no fence here')).toBeNull();
  });

  it('parseMetricsFence 解析有效 fence', () => {
    const metrics: GraphMetrics = {
      graphId: 'g-test', totalNodes: 4, completedNodes: 2, failedNodes: 0,
      skippedNodes: 0, fallbackActivations: 0, totalRounds: 10,
      totalToolCalls: 25, totalTokens: 50000, elapsedMs: 60000,
    };
    const notes = buildMetricsFence(metrics);
    const parsed = parseMetricsFence(notes);
    expect(parsed).toBeTruthy();
    expect(parsed!.totalNodes).toBe(4);
  });

  it('parsePersistedTaskGraph 解析所有 fence', () => {
    const snap = makeSnapshot();
    const metrics: GraphMetrics = {
      graphId: 'g-test', totalNodes: 4, completedNodes: 2, failedNodes: 0,
      skippedNodes: 0, fallbackActivations: 0, totalRounds: 10,
      totalToolCalls: 25, totalTokens: 50000, elapsedMs: 60000,
    };
    const notes = buildGraphFence(snap) + '\n\n' + buildMetricsFence(metrics);
    const result = parsePersistedTaskGraph(notes);
    expect(result.graph).toBeTruthy();
    expect(result.graph!.graphId).toBe('g-test');
    expect(result.metrics).toBeTruthy();
    expect(result.metrics!.totalNodes).toBe(4);
    expect(result.debug).toBeNull();
  });
});

// ═══════════════════════════════════════════════

describe('向后兼容', () => {
  it('旧 checkpoint JSON（无 taskGraph 字段）不报错', () => {
    const oldJson = JSON.stringify({
      version: 1,
      taskId: 'old-task',
      status: 'running',
      userGoal: 'test',
      phase: 'intent',
      // no taskGraph field
    });
    // parseGraphFence on old notes still returns null (no fence)
    expect(parseGraphFence(oldJson)).toBeNull();
  });

  it('parsePersistedTaskGraph 从无 fence 笔记恢复全 null', () => {
    const result = parsePersistedTaskGraph('# regular notes\nno fences here');
    expect(result.graph).toBeNull();
    expect(result.metrics).toBeNull();
    expect(result.debug).toBeNull();
  });
});
