import { describe, expect, it } from 'vitest';

import { RetrospectiveGraphBuilder } from '../../src/harness/supervisor/retrospective-graph-builder.js';
import type {
  DeviationSignal,
  WorkspaceSnapshot,
} from '../../src/types/supervisor.js';

function makeSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    snapshotId: 'snap-rg',
    at: 0,
    gitSummary: 'clean',
    filesAdded: [],
    filesModified: [],
    filesDeleted: [],
    ...overrides,
  };
}

describe('RetrospectiveGraphBuilder', () => {
  it('builds a template graph for intent=debug with no progress marked', () => {
    const builder = new RetrospectiveGraphBuilder();
    const result = builder.build({
      goal: 'fix login bug',
      intent: 'debug',
      snapshot: makeSnapshot(),
      signals: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.graph.nodes).length).toBeGreaterThan(0);
    expect(result.markedDone).toEqual([]);
    expect(result.signalsSummary).toBe('(none)');
  });

  it('marks inspect/search nodes done when snapshot reports file changes', () => {
    const builder = new RetrospectiveGraphBuilder();
    const result = builder.build({
      goal: 'investigate and resolve the recurring login authentication failure across services',
      intent: 'debug',
      snapshot: makeSnapshot({
        filesModified: ['src/login.ts'],
      }),
      signals: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nodeTypes = result.markedDone.map((id) => result.graph.nodes[id].type);
    expect(nodeTypes).toContain('inspect');
    expect(nodeTypes).toContain('search');
    expect(result.graph.cursor.completedNodeIds).toEqual(
      expect.arrayContaining(result.markedDone),
    );
    expect(result.graph.progress).toBeGreaterThan(0);
  });

  it('marks verify done when testSummary is passed', () => {
    const builder = new RetrospectiveGraphBuilder();
    const result = builder.build({
      goal: 'add tests',
      intent: 'test',
      snapshot: makeSnapshot({
        filesModified: ['src/login.ts'],
        testSummary: 'passed',
      }),
      signals: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verifyIds = Object.values(result.graph.nodes)
      .filter((n) => n.type === 'verify')
      .map((n) => n.id);
    if (verifyIds.length > 0) {
      expect(result.markedDone).toEqual(expect.arrayContaining(verifyIds));
    }
  });

  it('summarizes input signals into a comma-separated string', () => {
    const builder = new RetrospectiveGraphBuilder();
    const signals: DeviationSignal[] = [
      { type: 'tool_repeat_fail', count: 3 },
      { type: 'goal_drift', alignment: 0.31 },
      { type: 'scope_creep' },
    ];
    const result = builder.build({
      goal: 'refactor module',
      intent: 'refactor',
      snapshot: makeSnapshot(),
      signals,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signalsSummary).toBe('tool_repeat_fail:3,goal_drift:0.31,scope_creep');
  });

  it('advances cursor past consecutively done nodes', () => {
    const builder = new RetrospectiveGraphBuilder();
    const result = builder.build({
      goal: 'investigate and resolve the recurring login authentication failure across services',
      intent: 'debug',
      snapshot: makeSnapshot({
        filesModified: ['src/login.ts'],
        testSummary: 'passed',
      }),
      signals: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const branchIds = result.graph.mainBranch.nodeIds;
    const cursorNode = result.graph.nodes[result.graph.cursor.nodeId];
    if (cursorNode && cursorNode.status === 'running') {
      expect(['edit', 'summarize']).toContain(cursorNode.type);
    }
    expect(result.graph.cursor.nodeIndex).toBeGreaterThanOrEqual(0);
    expect(result.graph.cursor.nodeIndex).toBeLessThan(branchIds.length);
  });
});
