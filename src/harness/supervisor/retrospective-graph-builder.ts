import type { TaskGraph as TaskGraphData } from '../../types/task-graph.js';
import type {
  DeviationSignal,
  WorkspaceSnapshot,
} from '../../types/supervisor.js';
import { buildGraph } from '../task-graph-builder.js';
import type { TaskIntent } from '../../types/runtime-snapshot.js';
import { advanceCursor, startCurrentNode } from '../task-graph.js';

/**
 * §8.7 RetrospectiveGraphBuilder —— 接管阶段「反构图」入口（V1 模板图）。
 *
 * 输入：
 *   - goal / intent：复用 §19.2 表中「模板图最小集」，按 intent 走 `buildGraph`；
 *   - snapshot：§8.4 WorkspaceSnapshot，决定哪些节点可直接标记 `done`；
 *   - signals：本次 takeover 触发信号（用于后续 V2 决定额外 fallback 节点；V1 仅记录）。
 *
 * 输出：
 *   - graph：可直接交给 `GraphExecutor.replaceGraph` 的反向图；
 *   - markedDone：已标记 done 的节点 ID 列表；
 *   - reason：当无法构建时的失败原因（调用方按 §19.2 降级至二级强提示）。
 *
 * §19.2 已完成节点判定（V1）：
 *   - `inspect` / `context` 类：snapshot.filesAdded ∪ filesModified 非空 → done；
 *   - `verify` 类：snapshot.testSummary === 'passed' → done。
 *
 * V1 不做 LLM 重规划；调用方应在 SnapshotConfidence >= templateGraphMin 且
 * RecoverySafetyChecker.recoverable=true 时才走本路径。
 */

export interface RetrospectiveGraphBuildInput {
  goal: string;
  intent: TaskIntent;
  snapshot: WorkspaceSnapshot;
  signals: readonly DeviationSignal[];
  /** 用于 `buildGraph` 的可选 workspaceRoot；测试可忽略。 */
  workspaceRoot?: string;
  /** 注入时间戳/graphId，便于测试与 timeline 关联。 */
  now?: () => number;
  graphId?: string;
}

export interface RetrospectiveGraphBuildSuccess {
  ok: true;
  graph: TaskGraphData;
  /** 模板节点中已被标记为 `done` 的节点 id 列表。 */
  markedDone: string[];
  /** 本次 takeover 的 signal 摘要，落 timeline 用。 */
  signalsSummary: string;
}

export interface RetrospectiveGraphBuildFailure {
  ok: false;
  reason: 'empty_template' | 'build_threw';
  error?: string;
}

export type RetrospectiveGraphBuildResult =
  | RetrospectiveGraphBuildSuccess
  | RetrospectiveGraphBuildFailure;

export class RetrospectiveGraphBuilder {
  /** 构图入口；失败一律返回 `{ ok: false }`，不抛错。 */
  build(input: RetrospectiveGraphBuildInput): RetrospectiveGraphBuildResult {
    let graph: TaskGraphData;
    try {
      graph = buildGraph({
        goal: input.goal,
        intent: input.intent,
        workspaceRoot: input.workspaceRoot,
        now: input.now,
        graphId: input.graphId,
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'build_threw',
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (Object.keys(graph.nodes).length === 0) {
      return { ok: false, reason: 'empty_template' };
    }

    const markedDone = applyKnownProgress(graph, input.snapshot);
    advanceCursorPastDone(graph);

    return {
      ok: true,
      graph,
      markedDone,
      signalsSummary: summarizeSignals(input.signals),
    };
  }
}

export function createRetrospectiveGraphBuilder(): RetrospectiveGraphBuilder {
  return new RetrospectiveGraphBuilder();
}

function applyKnownProgress(graph: TaskGraphData, snapshot: WorkspaceSnapshot): string[] {
  const markedDone: string[] = [];
  const hasFileEvidence =
    snapshot.filesAdded.length + snapshot.filesModified.length > 0;
  const verifyPassed = snapshot.testSummary === 'passed';
  const now = Date.now();

  for (const node of graph.mainBranch.nodeIds.map((id) => graph.nodes[id]).filter(Boolean)) {
    if (node.status !== 'pending') continue;

    let shouldMark = false;
    if ((node.type === 'inspect' || node.type === 'search') && hasFileEvidence) {
      shouldMark = true;
    } else if (node.type === 'verify' && verifyPassed) {
      shouldMark = true;
    }

    if (shouldMark) {
      node.status = 'done';
      node.startedAt = node.startedAt ?? now;
      node.endedAt = now;
      graph.nodeHistory.push({
        nodeId: node.id,
        status: 'done',
        startedAt: node.startedAt,
        endedAt: node.endedAt,
        retries: node.retryCount,
      });
      markedDone.push(node.id);
    }
  }

  if (markedDone.length > 0) {
    const totalNodes = graph.mainBranch.nodeIds.length;
    const completedCount = markedDone.length;
    graph.progress = totalNodes > 0
      ? Math.min(100, Math.round((completedCount / totalNodes) * 100))
      : 0;
    graph.updatedAt = now;
  }

  return markedDone;
}

function advanceCursorPastDone(graph: TaskGraphData): void {
  const branchIds = graph.mainBranch.nodeIds;
  if (branchIds.length === 0) return;

  let idx = graph.cursor.nodeIndex;
  while (idx < branchIds.length) {
    const node = graph.nodes[branchIds[idx]];
    if (!node || node.status !== 'done') break;
    if (!graph.cursor.completedNodeIds.includes(node.id)) {
      graph.cursor.completedNodeIds.push(node.id);
    }
    idx += 1;
  }

  if (idx === graph.cursor.nodeIndex) return;
  // 直接重写 cursor，避免使用 advanceCursor 改 updatedAt 与 status 副作用。
  graph.cursor.nodeIndex = Math.min(idx, branchIds.length - 1);
  graph.cursor.nodeId = branchIds[graph.cursor.nodeIndex] ?? '';

  if (idx < branchIds.length) {
    // 当游标停留在 pending 节点上时显式启动它，与现有 lifecycle 一致。
    if (graph.nodes[graph.cursor.nodeId]?.status === 'pending') {
      startCurrentNode(graph);
    }
  } else {
    // 全部 done：让 advanceCursor 触发后续 markGraphDone 流程，但这里仅维持游标。
    const last = graph.nodes[branchIds[branchIds.length - 1]];
    if (last && last.status === 'done') {
      advanceCursor(graph); // returns undefined; safe no-op
    }
  }
}

function summarizeSignals(signals: readonly DeviationSignal[]): string {
  if (signals.length === 0) return '(none)';
  return signals
    .map((signal) => {
      switch (signal.type) {
        case 'tool_repeat_fail':
          return `tool_repeat_fail:${signal.count}`;
        case 'no_progress':
          return `no_progress:${signal.rounds}`;
        case 'file_loop':
          return `file_loop:${signal.path}:${signal.count}`;
        case 'goal_drift':
          return `goal_drift:${signal.alignment.toFixed(2)}`;
        case 'scope_creep':
          return 'scope_creep';
        case 'user_force_takeover':
          return 'user_force_takeover';
      }
    })
    .join(',');
}
