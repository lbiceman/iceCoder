/**
 * TaskGraph — 任务图核心数据结构与操作。
 *
 * 提供图 CRUD、游标推进、分支切换、快照持久化、图压缩、会话管理等。
 * 纯函数/纯数据结构，不依赖 LLM、不依赖 Harness 内部状态。
 *
 * 设计文档：docs/任务图规划-设计文档.md §5, §8, §9, §25, §28
 */

import { randomUUID } from 'node:crypto';
import type {
  TaskNode,
  TaskNodeStatus,
  TaskEdge,
  ExecutionBranch,
  FallbackBranch,
  FallbackReason,
  ExecutionCursor,
  TaskGraph as TaskGraphData,
  NodeHistoryEntry,
  BranchHistoryEntry,
  TaskGraphSnapshot,
  GraphRecoverySignal,
  GraphSession,
  GraphSessionStatus,
} from '../types/task-graph.js';
import { TASK_GRAPH_SCHEMA_VERSION } from '../types/task-graph.js';
import type { TaskIntent, TaskPhase } from '../types/runtime-snapshot.js';

const TASK_PHASE_RANK: Record<TaskPhase, number> = {
  intent: 0,
  context: 1,
  editing: 2,
  verification: 3,
  final: 4,
};

export interface SyncCursorToPhaseResult {
  changed: boolean;
  previousNodeId?: string;
  currentNodeId?: string;
}

// ═══════════════════════════════════════════════
// Construction
// ═══════════════════════════════════════════════

export interface TaskGraphOptions {
  goal: string;
  intent: TaskIntent;
  nodes: TaskNode[];
  edges?: TaskEdge[];
  /** 注入时间戳（测试可控） */
  now?: () => number;
  /** 注入 graphId（测试可控） */
  graphId?: string;
}

/** 图压缩配置 */
export interface GraphCompactionConfig {
  maxNodeHistoryEntries: number;
  maxBranchHistoryEntries: number;
  compactErrors: boolean;
  pruneDeadFallbacks: boolean;
}

export const DEFAULT_GRAPH_COMPACTION: GraphCompactionConfig = {
  maxNodeHistoryEntries: 50,
  maxBranchHistoryEntries: 20,
  compactErrors: true,
  pruneDeadFallbacks: true,
};

export function createTaskGraph(opts: TaskGraphOptions): TaskGraphData {
  const now = opts.now ?? (() => Date.now());
  const graphId = opts.graphId ?? randomUUID();
  const nodeMap = nodesToMap(opts.nodes);
  const mainBranch: ExecutionBranch = {
    id: `branch-main-${graphId}`,
    nodeIds: opts.nodes.filter(n => n.type !== 'fallback').map(n => n.id),
    isFallback: false,
  };

  const fallbackNodes = opts.nodes.filter(n => n.type === 'fallback');
  const fallbackBranches: FallbackBranch[] = fallbackNodes.map((fn, i) => ({
    id: `branch-fallback-${graphId}-${i}`,
    sourceBranchId: mainBranch.id,
    failedNodeId: '',
    nodeIds: [fn.id],
    reason: 'retries_exceeded' as FallbackReason,
    attemptCount: 0,
    maxAttempts: 1,
  }));

  const cursor: ExecutionCursor = {
    branchId: mainBranch.id,
    nodeId: mainBranch.nodeIds[0] ?? '',
    nodeIndex: 0,
    completedNodeIds: [],
    skippedNodeIds: [],
  };

  const ts = now();
  return {
    version: TASK_GRAPH_SCHEMA_VERSION,
    graphId,
    goal: opts.goal,
    intent: opts.intent,
    nodes: nodeMap,
    edges: opts.edges ?? buildDefaultEdges(opts.nodes),
    mainBranch,
    fallbackBranches,
    cursor,
    status: 'ready',
    progress: 0,
    createdAt: ts,
    updatedAt: ts,
    nodeHistory: [],
    branchHistory: [],
  };
}

// ═══════════════════════════════════════════════
// Node Operations
// ═══════════════════════════════════════════════

export function getCurrentNode(graph: TaskGraphData): TaskNode | undefined {
  return graph.nodes[graph.cursor.nodeId];
}

export function getNode(graph: TaskGraphData, nodeId: string): TaskNode | undefined {
  return graph.nodes[nodeId];
}

export function getCurrentBranchNodes(graph: TaskGraphData): TaskNode[] {
  const branch = getCurrentBranch(graph);
  if (!branch) return [];
  return branch.nodeIds.map(id => graph.nodes[id]).filter(Boolean);
}

export function getMainBranchNodes(graph: TaskGraphData): TaskNode[] {
  return graph.mainBranch.nodeIds.map(id => graph.nodes[id]).filter(Boolean);
}

export function getFallbackBranchNodes(graph: TaskGraphData): TaskNode[] {
  return graph.fallbackBranches
    .flatMap(b => b.nodeIds)
    .map(id => graph.nodes[id])
    .filter(Boolean);
}

export function findNodesByType(graph: TaskGraphData, type: TaskNode['type']): TaskNode[] {
  return Object.values(graph.nodes).filter(n => n.type === type);
}

export function hasPendingNodes(graph: TaskGraphData): boolean {
  const branch = getCurrentBranch(graph);
  if (!branch) return false;
  return branch.nodeIds.some(id => {
    const n = graph.nodes[id];
    return n && n.status === 'pending';
  });
}

// ═══════════════════════════════════════════════
// Cursor Operations
// ═══════════════════════════════════════════════

export function advanceCursor(graph: TaskGraphData): TaskNode | undefined {
  const branch = getCurrentBranch(graph);
  if (!branch) return undefined;

  const nextIndex = graph.cursor.nodeIndex + 1;
  if (nextIndex >= branch.nodeIds.length) return undefined;

  const nextId = branch.nodeIds[nextIndex];
  const nextNode = graph.nodes[nextId];
  if (!nextNode) return undefined;

  graph.cursor.nodeIndex = nextIndex;
  graph.cursor.nodeId = nextId;
  graph.updatedAt = Date.now();
  return nextNode;
}

export function startCurrentNode(graph: TaskGraphData): TaskNode | undefined {
  const node = getCurrentNode(graph);
  if (!node) return undefined;

  const now = Date.now();
  node.status = 'running';
  node.startedAt = now;
  graph.status = 'running';
  graph.updatedAt = now;
  return node;
}

export function completeCurrentNode(graph: TaskGraphData, error?: string): void {
  const node = getCurrentNode(graph);
  if (!node) return;

  const now = Date.now();
  if (error) {
    node.status = 'failed';
    node.error = error;
  } else {
    node.status = 'done';
  }
  node.endedAt = now;
  graph.cursor.completedNodeIds.push(node.id);
  graph.nodeHistory.push({
    nodeId: node.id,
    status: node.status === 'failed' ? 'failed' : 'done',
    startedAt: node.startedAt ?? now,
    endedAt: now,
    retries: node.retryCount,
    error: node.error,
  });
  graph.updatedAt = now;
  recalcProgress(graph);
}

export function skipCurrentNode(graph: TaskGraphData, reason?: string): void {
  const node = getCurrentNode(graph);
  if (!node) return;

  const now = Date.now();
  node.status = 'skipped';
  node.endedAt = now;
  node.error = reason;
  graph.cursor.skippedNodeIds.push(node.id);
  graph.nodeHistory.push({
    nodeId: node.id,
    status: 'skipped',
    startedAt: node.startedAt ?? now,
    endedAt: now,
    retries: node.retryCount,
    error: reason,
  });
  graph.updatedAt = now;
  recalcProgress(graph);
}

export function incrementRetry(graph: TaskGraphData): boolean {
  const node = getCurrentNode(graph);
  if (!node) return false;

  node.retryCount++;
  graph.updatedAt = Date.now();
  return node.retryCount >= node.maxRetries;
}

/**
 * 将图游标与 TaskState.phase 对齐（仅向前推进，不回退）。
 * 供工具轮结束后同步任务面板当前步骤。
 */
export function syncCursorToTaskPhase(
  graph: TaskGraphData,
  taskPhase: TaskPhase,
): SyncCursorToPhaseResult {
  const branch = getCurrentBranch(graph);
  if (!branch || branch.isFallback) return { changed: false };

  const nodeIds = branch.nodeIds.filter(id => graph.nodes[id]?.type !== 'fallback');
  if (nodeIds.length === 0) return { changed: false };

  const nodes = nodeIds.map(id => graph.nodes[id]).filter(Boolean) as TaskNode[];
  const targetIdx = resolveTargetNodeIndex(nodes, taskPhase);
  if (targetIdx < 0) return { changed: false };

  const previousNodeId = graph.cursor.nodeId;
  const previousIndex = graph.cursor.nodeIndex;
  const targetNodeId = nodeIds[targetIdx];
  if (!targetNodeId) return { changed: false };

  if (targetIdx < previousIndex) {
    return { changed: false, previousNodeId, currentNodeId: previousNodeId };
  }

  const now = Date.now();
  let changed = false;

  for (let i = 0; i < targetIdx; i++) {
    const node = graph.nodes[nodeIds[i]];
    if (!node || node.status === 'done' || node.status === 'skipped' || node.status === 'failed') {
      continue;
    }
    markNodeDoneForSync(graph, node, now);
    changed = true;
  }

  if (previousIndex !== targetIdx || previousNodeId !== targetNodeId) {
    graph.cursor.nodeIndex = targetIdx;
    graph.cursor.nodeId = targetNodeId;
    changed = true;
  }

  const targetNode = graph.nodes[targetNodeId];
  if (targetNode && targetNode.status === 'pending') {
    startCurrentNode(graph);
    changed = true;
  } else if (targetNode && targetNode.status === 'done' && targetIdx === nodeIds.length - 1) {
    graph.updatedAt = now;
  }

  if (changed) {
    recalcProgress(graph);
  }

  return {
    changed,
    previousNodeId,
    currentNodeId: graph.cursor.nodeId,
  };
}

function nodePhaseRank(node: TaskNode): number {
  return TASK_PHASE_RANK[node.phase as TaskPhase] ?? 0;
}

function resolveTargetNodeIndex(nodes: TaskNode[], taskPhase: TaskPhase): number {
  if (nodes.length === 0) return -1;

  const taskRank = TASK_PHASE_RANK[taskPhase];

  for (let i = 0; i < nodes.length; i++) {
    if (nodePhaseRank(nodes[i]) === taskRank) return i;
  }

  if (taskRank <= nodePhaseRank(nodes[0])) return 0;

  let idx = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodePhaseRank(nodes[i]) <= taskRank) idx = i;
  }

  if (taskRank >= TASK_PHASE_RANK.verification) {
    for (let i = 0; i < nodes.length; i++) {
      if (nodePhaseRank(nodes[i]) >= taskRank) return i;
    }
  }

  return idx;
}

function markNodeDoneForSync(graph: TaskGraphData, node: TaskNode, now: number): void {
  node.status = 'done';
  node.startedAt = node.startedAt ?? now;
  node.endedAt = now;
  if (!graph.cursor.completedNodeIds.includes(node.id)) {
    graph.cursor.completedNodeIds.push(node.id);
  }
  const alreadyRecorded = graph.nodeHistory.some(h => h.nodeId === node.id && h.status === 'done');
  if (!alreadyRecorded) {
    graph.nodeHistory.push({
      nodeId: node.id,
      status: 'done',
      startedAt: node.startedAt,
      endedAt: now,
      retries: node.retryCount,
    });
  }
  graph.updatedAt = now;
}

// ═══════════════════════════════════════════════
// Branch Operations
// ═══════════════════════════════════════════════

export function switchToFallbackBranch(
  graph: TaskGraphData,
  reason: FallbackReason,
): ExecutionCursor | null {
  const fallback = graph.fallbackBranches.find(
    f => f.attemptCount < f.maxAttempts,
  );
  if (!fallback) return null;

  fallback.attemptCount++;
  fallback.reason = reason;
  fallback.failedNodeId = graph.cursor.nodeId;

  const cursor: ExecutionCursor = {
    branchId: fallback.id,
    nodeId: fallback.nodeIds[0] ?? '',
    nodeIndex: 0,
    completedNodeIds: [...graph.cursor.completedNodeIds],
    skippedNodeIds: [...graph.cursor.skippedNodeIds],
  };

  graph.cursor = cursor;
  graph.updatedAt = Date.now();
  graph.branchHistory.push({
    branchId: fallback.id,
    reason,
    at: Date.now(),
  });

  return cursor;
}

export function hasAvailableFallback(graph: TaskGraphData): boolean {
  return graph.fallbackBranches.some(f => f.attemptCount < f.maxAttempts);
}

export function getCurrentBranchId(graph: TaskGraphData): string {
  return graph.cursor.branchId;
}

// ═══════════════════════════════════════════════
// Status Operations
// ═══════════════════════════════════════════════

export function markGraphDone(graph: TaskGraphData): void {
  graph.status = 'done';
  graph.progress = 100;
  graph.updatedAt = Date.now();
}

export function markGraphFailed(graph: TaskGraphData, error?: string): void {
  graph.status = 'failed';
  graph.updatedAt = Date.now();

  const node = getCurrentNode(graph);
  if (node && error) {
    node.error = error;
  }
  recalcProgress(graph);
}

export function markGraphPaused(graph: TaskGraphData): void {
  graph.status = 'paused';
  graph.updatedAt = Date.now();
}

// ═══════════════════════════════════════════════
// Recovery Signal
// ═══════════════════════════════════════════════

export function needsRecovery(graph: TaskGraphData): GraphRecoverySignal | null {
  const node = getCurrentNode(graph);
  if (!node) return null;

  if (node.retryCount >= node.maxRetries && node.status === 'failed') {
    return {
      source: 'node_failure',
      nodeId: node.id,
      level: 'fallback',
      message: `节点 ${node.id} (${node.title}) 已达最大重试次数 ${node.maxRetries}`,
      at: Date.now(),
    };
  }

  if (node.status === 'failed' && node.error) {
    return {
      source: 'node_failure',
      nodeId: node.id,
      level: 'retry',
      message: `节点 ${node.id} 执行失败: ${node.error}`,
      at: Date.now(),
    };
  }

  return null;
}

// ═══════════════════════════════════════════════
// Snapshot (Checkpoint persistence)
// ═══════════════════════════════════════════════

export function toSnapshot(graph: TaskGraphData): TaskGraphSnapshot {
  const nodes: TaskGraphSnapshot['nodes'] = {};
  for (const [id, node] of Object.entries(graph.nodes)) {
    nodes[id] = { status: node.status, retryCount: node.retryCount, error: node.error };
  }

  return {
    version: TASK_GRAPH_SCHEMA_VERSION,
    graphId: graph.graphId,
    goal: graph.goal,
    intent: graph.intent,
    status: graph.status,
    progress: graph.progress,
    cursor: {
      branchId: graph.cursor.branchId,
      nodeId: graph.cursor.nodeId,
      nodeIndex: graph.cursor.nodeIndex,
      completedNodeIds: [...graph.cursor.completedNodeIds],
      skippedNodeIds: [...graph.cursor.skippedNodeIds],
    },
    nodes,
    nodeHistory: graph.nodeHistory.map(h => ({ ...h })),
    branchHistory: graph.branchHistory.map(h => ({ ...h })),
    updatedAt: graph.updatedAt,
  };
}

export function applySnapshot(graph: TaskGraphData, snapshot: TaskGraphSnapshot): void {
  graph.status = snapshot.status;
  graph.progress = snapshot.progress;
  graph.cursor = {
    branchId: snapshot.cursor.branchId,
    nodeId: snapshot.cursor.nodeId,
    nodeIndex: snapshot.cursor.nodeIndex,
    completedNodeIds: [...snapshot.cursor.completedNodeIds],
    skippedNodeIds: [...snapshot.cursor.skippedNodeIds],
  };
  graph.nodeHistory = snapshot.nodeHistory.map(h => ({ ...h }));
  graph.branchHistory = snapshot.branchHistory.map(h => ({ ...h }));
  graph.updatedAt = snapshot.updatedAt;

  for (const [id, snap] of Object.entries(snapshot.nodes)) {
    const node = graph.nodes[id];
    if (node) {
      node.status = snap.status;
      node.retryCount = snap.retryCount;
      if (snap.error) node.error = snap.error;
    }
  }
}

// ═══════════════════════════════════════════════
// Graph Compaction
// ═══════════════════════════════════════════════

export function compactGraph(
  graph: TaskGraphData,
  config: GraphCompactionConfig = DEFAULT_GRAPH_COMPACTION,
): void {
  // 1. nodeHistory 截断
  if (graph.nodeHistory.length > config.maxNodeHistoryEntries) {
    // 保留最近 N 条，但保留所有 failed 记录
    const keep = config.maxNodeHistoryEntries;
    const failedRecords = graph.nodeHistory.filter(h => h.status === 'failed');
    const recentRecords = graph.nodeHistory.slice(-keep);
    // 合并：保留所有 failed + 最近 keep 条（去重）
    const keepIds = new Set(recentRecords.map(h => h.nodeId));
    const uniqueFailed = failedRecords.filter(h => !keepIds.has(h.nodeId));
    graph.nodeHistory = [...uniqueFailed, ...recentRecords];
  }

  // 2. branchHistory 截断
  if (graph.branchHistory.length > config.maxBranchHistoryEntries) {
    graph.branchHistory = graph.branchHistory.slice(-config.maxBranchHistoryEntries);
  }

  // 3. 压缩 done 节点
  if (config.compactErrors) {
    for (const node of Object.values(graph.nodes)) {
      if (node.status === 'done' && node.error) {
        node.error = node.error.slice(0, 200);
      }
    }
  }

  // 4. 剪枝已耗尽 fallback
  if (config.pruneDeadFallbacks) {
    graph.fallbackBranches = graph.fallbackBranches.filter(
      f => f.attemptCount < f.maxAttempts,
    );
  }

  graph.updatedAt = Date.now();
}

// ═══════════════════════════════════════════════
// Graph Session Management
// ═══════════════════════════════════════════════

const graphSessions = new Map<string, GraphSession>();

export function createGraphSession(
  graphId: string,
  taskId: string,
  goal: string,
  sessionIndex: number,
): GraphSession {
  const session: GraphSession = {
    graphId,
    taskId,
    status: 'active',
    goal,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    sessionIndex,
  };
  graphSessions.set(graphId, session);
  return session;
}

export function transitionSession(
  graphId: string,
  status: GraphSessionStatus,
): GraphSession | undefined {
  const session = graphSessions.get(graphId);
  if (!session) return undefined;
  session.status = status;
  session.lastActiveAt = Date.now();
  return session;
}

export function findActiveSession(): GraphSession | undefined {
  for (const session of graphSessions.values()) {
    if (session.status === 'active') return session;
  }
  return undefined;
}

export function getSession(graphId: string): GraphSession | undefined {
  return graphSessions.get(graphId);
}

export function clearSession(graphId: string): void {
  graphSessions.delete(graphId);
}

// ═══════════════════════════════════════════════
// Internal Helpers
// ═══════════════════════════════════════════════

function getCurrentBranch(graph: TaskGraphData): ExecutionBranch | undefined {
  if (graph.cursor.branchId === graph.mainBranch.id) return graph.mainBranch;
  for (const fb of graph.fallbackBranches) {
    if (fb.id === graph.cursor.branchId) {
      return { id: fb.id, nodeIds: fb.nodeIds, isFallback: true, triggerReason: fb.reason };
    }
  }
  return undefined;
}

function nodesToMap(nodes: TaskNode[]): Record<string, TaskNode> {
  const map: Record<string, TaskNode> = {};
  for (const node of nodes) {
    map[node.id] = { ...node };
  }
  return map;
}

function buildDefaultEdges(nodes: TaskNode[]): TaskEdge[] {
  const nonFallback = nodes.filter(n => n.type !== 'fallback');
  const edges: TaskEdge[] = [];
  for (let i = 1; i < nonFallback.length; i++) {
    edges.push({ from: nonFallback[i - 1].id, to: nonFallback[i].id, type: 'normal' });
  }
  return edges;
}

function recalcProgress(graph: TaskGraphData): void {
  const branch = getCurrentBranch(graph);
  if (!branch || branch.nodeIds.length === 0) {
    graph.progress = 0;
    return;
  }
  let completed = 0;
  for (const id of branch.nodeIds) {
    const n = graph.nodes[id];
    if (n && (n.status === 'done' || n.status === 'skipped')) completed++;
  }
  graph.progress = Math.round((completed / branch.nodeIds.length) * 100);
}
