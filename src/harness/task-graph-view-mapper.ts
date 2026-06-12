/**
 * TaskGraph → 前端任务图面板（TaskGraphView）。
 */

import type { TaskGraph as TaskGraphData, TaskNode, TaskNodeStatus } from '../types/task-graph.js';
import type { TaskGraphNodeStatus, TaskGraphNodeView, TaskGraphView } from '../types/task-graph-view.js';
import { getMainBranchNodes } from './task-graph.js';

function mapStatus(status: TaskNodeStatus, isActive: boolean): TaskGraphNodeStatus {
  if (isActive && status === 'pending') return 'running';
  if (status === 'pending' || status === 'running' || status === 'done' || status === 'failed' || status === 'skipped') {
    return status;
  }
  return 'pending';
}

function nodeToView(node: TaskNode, activeId: string | undefined): TaskGraphNodeView {
  const isActive = node.id === activeId;
  return {
    id: node.id,
    title: node.title,
    phase: node.phase,
    suggestedTools: node.suggestedTools,
    requiresTool: node.requiresTool,
    isVerification: node.type === 'verify',
    status: mapStatus(node.status, isActive),
    startedAt: node.startedAt,
    endedAt: node.endedAt,
    error: node.error,
    evidence: node.evidence,
  };
}

export function taskGraphToView(graph: TaskGraphData): TaskGraphView {
  const activeId = graph.cursor?.nodeId;
  const steps = getMainBranchNodes(graph).map(n => nodeToView(n, activeId));

  return {
    planId: graph.graphId,
    goal: graph.goal,
    intent: graph.intent,
    steps,
    activeStepId: activeId,
    progress: graph.progress ?? 0,
    createdAt: graph.createdAt,
    updatedAt: graph.updatedAt,
  };
}
