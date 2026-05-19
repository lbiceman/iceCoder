/**
 * TaskGraph Metrics — 指标计算与 Replay 构建。
 *
 * 实现：
 *   1. calcNodeScore / calcBranchEfficiency / calcSuccessConfidence
 *   2. buildGraphMetrics
 *   3. ReplayBuilder
 *
 * 依赖：Phase 1 (types)
 */

import { randomUUID } from 'node:crypto';
import type {
  NodeMetrics,
  BranchMetrics,
  GraphMetrics,
  NodeReplay,
  BranchReplay,
  ToolReplay,
  FailureReplay,
  SubAgentReplay,
  CheckpointReplay,
  ReplayTrace,
  ReplayType,
} from '../types/task-graph.js';

// ═══════════════════════════════════════════════
// Score Calculations
// ═══════════════════════════════════════════════

export function calcNodeScore(metrics: NodeMetrics): number {
  if (metrics.success) {
    const base = 60;
    const signalBonus = metrics.signalCompletionRate * 40;
    const idlePenalty = metrics.idleRounds * 5;
    const retryPenalty = metrics.retries * 10;
    return Math.max(0, Math.min(100, base + signalBonus - idlePenalty - retryPenalty));
  }
  const base = 30;
  const retryPenalty = metrics.retries * 10;
  const idlePenalty = metrics.idleRounds * 5;
  return Math.max(0, base - retryPenalty - idlePenalty);
}

export function calcBranchEfficiency(metrics: BranchMetrics): number {
  return Math.max(0, Math.min(100, metrics.branchEfficiency));
}

export function calcSuccessConfidence(metrics: GraphMetrics): number {
  const cs = metrics.completionScore / 100;
  const dr = metrics.deterministicRatio;
  const rs = metrics.recoverySuccessRate;
  const raw = cs * 0.5 + dr * 0.3 + rs * 0.2;
  return Math.max(0, Math.min(1, Math.round(raw * 1000) / 1000));
}

// ═══════════════════════════════════════════════
// buildGraphMetrics
// ═══════════════════════════════════════════════

export interface GraphMetricsInput {
  graphId: string;
  goal: string;
  intent: string;
  nodeMetrics: NodeMetrics[];
  branchMetrics: BranchMetrics[];
  totalRounds: number;
  totalToolCalls: number;
  totalDuration: number;
}

export function buildGraphMetrics(input: GraphMetricsInput): GraphMetrics {
  const completedNodes = input.nodeMetrics.filter(n => n.success).length;
  const completionScore = input.nodeMetrics.length > 0
    ? Math.round((completedNodes / input.nodeMetrics.length) * 100)
    : 0;

  const fallbackBranches = input.branchMetrics.filter(b => b.isFallback);
  const deterministicRatio = input.branchMetrics.length > 0
    ? Math.round((1 - fallbackBranches.length / input.branchMetrics.length) * 1000) / 1000
    : 1;
  const fallbackSuccess = fallbackBranches.filter(b => b.branchEfficiency > 50).length;
  const recoverySuccessRate = fallbackBranches.length > 0
    ? Math.round((fallbackSuccess / fallbackBranches.length) * 1000) / 1000
    : 1;

  const wastedSteps = input.nodeMetrics.filter(n => !n.success).length;

  const metrics: GraphMetrics = {
    graphId: input.graphId,
    goal: input.goal,
    intent: input.intent as GraphMetrics['intent'],
    completionScore,
    deterministicRatio,
    recoverySuccessRate,
    wastedSteps,
    successConfidence: 0,
    nodeMetrics: input.nodeMetrics,
    branchMetrics: input.branchMetrics,
    totalDuration: input.totalDuration,
    totalRounds: input.totalRounds,
    totalToolCalls: input.totalToolCalls,
    evaluatedAt: Date.now(),
  };

  metrics.successConfidence = calcSuccessConfidence(metrics);
  return metrics;
}

// ═══════════════════════════════════════════════
// ReplayBuilder
// ═══════════════════════════════════════════════

interface CheckpointData {
  runtimeV2?: {
    recentTools?: Array<{ name: string; at: number; success?: boolean; args?: Record<string, unknown> }>;
    recentFailures?: Array<{ signature: string; lastError?: string; at: number }>;
  };
}

export class ReplayBuilder {
  static build(graphId: string, checkpoint: CheckpointData | null, _sessionNotes: string): ReplayTrace {
    const toolReplays = this.buildToolTrace(graphId, checkpoint);
    const failureReplays = this.buildFailureTrace(graphId, checkpoint);

    return {
      graphId,
      replayId: `${graphId}-replay`,
      replayType: 'full' as ReplayType,
      nodeReplays: [],
      branchReplays: [],
      toolReplays,
      failureReplays,
      subAgentReplays: [] as SubAgentReplay[],
      checkpointSnapshots: [] as CheckpointReplay[],
      startedAt: toolReplays[0]?.calledAt ?? Date.now(),
      endedAt: Date.now(),
    };
  }

  static buildToolTrace(graphId: string, checkpoint: CheckpointData | null): ToolReplay[] {
    const tools = checkpoint?.runtimeV2?.recentTools ?? [];
    return tools.map((t, i) => ({
      replayId: `${graphId}-tool-${i + 1}`,
      toolName: t.name,
      argsSignature: JSON.stringify(t.args ?? {}).slice(0, 80),
      success: t.success ?? true,
      duration: 0,
      calledAt: t.at,
      nodeId: '',
    }));
  }

  static buildFailureTrace(graphId: string, checkpoint: CheckpointData | null): FailureReplay[] {
    const failures = checkpoint?.runtimeV2?.recentFailures ?? [];
    return failures.map((f, i) => ({
      replayId: `${graphId}-fail-${i + 1}`,
      failureType: 'tool_error' as const,
      nodeId: '',
      errorMessage: f.lastError ?? 'unknown error',
      recoveryAction: 'retry' as const,
      recoveredSuccessfully: false,
      at: f.at,
    }));
  }

  static buildNodeReplays(_graph: unknown, _toolTrace: ToolReplay[]): NodeReplay[] {
    return [];
  }

  static buildBranchReplays(_graph: unknown): BranchReplay[] {
    return [];
  }
}
