/**
 * TaskGraph Executor — 将 TaskGraph 集成到 Harness 循环的桥梁。
 *
 * 职责：
 *   1. 持有 TaskGraph 实例
 *   2. 管理 ContractValidator / DeviationDetector / EscalationManager / FailureClassifier
 *   3. 提供 Harness 循环所需的注入点（节点上下文、工具约束、轮次评估、游标推进）
 *
 * 依赖：Phase 1 (types), Phase 2 (task-graph), Phase 3 (builder), Phase 4 (review)
 */

import type { TaskGraph as TaskGraphData, NodeContract, OutputSignal } from '../types/task-graph.js';
import type { TaskIntent } from '../types/runtime-snapshot.js';
import { buildGraph } from './task-graph-builder.js';
import {
  createTaskGraph,
  getCurrentNode,
  startCurrentNode,
  completeCurrentNode,
  advanceCursor,
  markGraphDone,
  markGraphFailed,
  toSnapshot,
  applySnapshot,
  needsRecovery,
  switchToFallbackBranch,
} from './task-graph.js';
import {
  ContractValidator,
  DeviationDetector,
  FailureClassifier,
  EscalationManager,
} from './task-graph-review.js';
import type { TaskGraphSnapshot } from '../types/task-graph.js';
import type { TaskGraphView } from '../types/task-graph-view.js';
import { taskGraphToView } from './task-graph-view-mapper.js';

// ═══════════════════════════════════════════════
// GraphExecutor
// ═══════════════════════════════════════════════

export interface InitOptions {
  goal: string;
  intent: TaskIntent;
}

export interface ToolCheckResult {
  action: 'allow' | 'warn' | 'block';
  message?: string;
}

export interface RoundEvalResult {
  action: 'none' | 'inject_hint' | 'block' | 'force_switch';
  message?: string;
}

export interface AdvanceResult {
  advanced: boolean;
  graphDone: boolean;
  nextNodeTitle?: string;
}

export class GraphExecutor {
  private graph: TaskGraphData | null = null;
  private contractValidator: ContractValidator | null = null;
  private deviationDetector = new DeviationDetector();
  private escalationManager = new EscalationManager();
  private failureClassifier = new FailureClassifier();
  private currentRoundToolNames: string[] = [];

  // ═══════════════════════════════════════════════
  // Graph Lifecycle
  // ═══════════════════════════════════════════════

  initGraph(opts: InitOptions): void {
    this.graph = buildGraph({ goal: opts.goal, intent: opts.intent });
    this.resetNodeState();
  }

  resetGraph(): void {
    this.graph = null;
    this.contractValidator = null;
    this.escalationManager.reset();
    this.failureClassifier.reset();
    this.currentRoundToolNames = [];
  }

  hasGraph(): boolean {
    return this.graph !== null;
  }

  /** 供 task_graph_init 推送步骤列表（实现/新增/创建等 edit 建图共用） */
  toView(): TaskGraphView | null {
    if (!this.graph) return null;
    return taskGraphToView(this.graph);
  }

  isTerminal(): boolean {
    return this.graph?.status === 'done' || this.graph?.status === 'failed';
  }

  shouldForceStop(): boolean {
    if (!this.graph) return false;
    if (this.isTerminal()) return true;
    return false;
  }

  // ═══════════════════════════════════════════════
  // Node Context (for system reminder injection)
  // ═══════════════════════════════════════════════

  getCurrentNodeContext(): string | null {
    if (!this.graph) return null;
    const node = getCurrentNode(this.graph);
    if (!node) return null;

    const lines: string[] = [
      `[TaskGraph] 当前步骤: ${node.title} (${node.type})`,
      `进度: ${this.graph.progress}% | 状态: ${this.graph.status}`,
    ];

    if (node.suggestedTools?.length) {
      lines.push(`建议工具: ${node.suggestedTools.join(', ')}`);
    }
    if (node.evidence) {
      lines.push(`参考文件: ${node.evidence}`);
    }

    return lines.join('\n');
  }

  // ═══════════════════════════════════════════════
  // Tool Call Checking
  // ═══════════════════════════════════════════════

  checkToolCall(toolName: string): ToolCheckResult {
    if (!this.graph) return { action: 'allow' };

    // Lazy init contract validator for current node
    if (!this.contractValidator) {
      const node = getCurrentNode(this.graph);
      if (!node) return { action: 'allow' };
      const contract = this.buildNodeContract(node.id);
      this.contractValidator = new ContractValidator(contract);
    }

    const result = this.contractValidator.checkBeforeToolCall(toolName);
    this.currentRoundToolNames.push(toolName);

    // Deviation check
    if (result.action !== 'block') {
      const node = getCurrentNode(this.graph)!;
      const devResult = this.deviationDetector.detect({
        toolNames: [...this.currentRoundToolNames],
        allowedTools: node.suggestedTools ?? [],
        nodePhase: node.phase,
        nodeGuard: { maxSameToolRepeat: 3 },
      });
      if (devResult.deviated && devResult.severity === 'hard') {
        const hint = 'message' in devResult.correction ? devResult.correction.message : devResult.description;
        return { action: 'warn', message: hint };
      }
    }

    const action = result.action === 'force_switch' ? 'block' : result.action;
    return { action, message: result.message };
  }

  recordToolResult(toolName: string, success: boolean, signal?: OutputSignal): void {
    if (!this.contractValidator) return;
    this.contractValidator.recordAfterToolCall(toolName, success, signal);
  }

  // ═══════════════════════════════════════════════
  // Round Evaluation
  // ═══════════════════════════════════════════════

  evaluateRound(toolCallsThisRound: number): RoundEvalResult {
    if (!this.graph || !this.contractValidator) return { action: 'none' };

    // Contract round-end check
    const cResult = this.contractValidator.checkRoundEnd(toolCallsThisRound);
    if (cResult.action === 'force_switch') {
      this.attemptFallback(cResult.message ?? 'contract violation');
      return { action: 'force_switch', message: cResult.message };
    }

    // Escalation check for deviations
    const node = getCurrentNode(this.graph);
    if (node) {
      const devResult = this.deviationDetector.detect({
        toolNames: [...this.currentRoundToolNames],
        allowedTools: node.suggestedTools ?? [],
        nodePhase: node.phase,
        nodeGuard: { maxSameToolRepeat: 3 },
      });

      const severity = devResult.deviated ? devResult.severity : 'soft';
      const esc = this.escalationManager.evaluate(severity, node.id);

      if (esc.action === 'force_switch') {
        this.attemptFallback(esc.message ?? 'escalation');
      }

      this.currentRoundToolNames = [];
      return { action: esc.action, message: esc.message };
    }

    this.currentRoundToolNames = [];
    return { action: 'none' };
  }

  // ═══════════════════════════════════════════════
  // Cursor Advancement
  // ═══════════════════════════════════════════════

  advanceOrComplete(): AdvanceResult {
    if (!this.graph) return { advanced: false, graphDone: false };

    const currentNode = getCurrentNode(this.graph);
    if (currentNode && currentNode.status !== 'done') {
      completeCurrentNode(this.graph);
    }

    const nextNode = advanceCursor(this.graph);
    if (nextNode) {
      startCurrentNode(this.graph);
      this.resetNodeState();
      return { advanced: true, graphDone: false, nextNodeTitle: nextNode.title };
    }

    // No more nodes on main branch
    if (this.graph.status !== 'failed') {
      markGraphDone(this.graph);
    }
    return { advanced: false, graphDone: true };
  }

  // ═══════════════════════════════════════════════
  // Snapshot
  // ═══════════════════════════════════════════════

  toSnapshot(): TaskGraphSnapshot | null {
    if (!this.graph) return null;
    return toSnapshot(this.graph);
  }

  applySnapshot(snapshot: TaskGraphSnapshot): void {
    if (!this.graph) return;
    applySnapshot(this.graph, snapshot);
  }

  classifyFailure(error: string, toolName?: string): ReturnType<FailureClassifier['classify']> {
    return this.failureClassifier.classify(error, toolName);
  }

  // ═══════════════════════════════════════════════
  // Internals
  // ═══════════════════════════════════════════════

  private resetNodeState(): void {
    this.contractValidator = null;
    this.escalationManager.reset();
    this.currentRoundToolNames = [];
  }

  private buildNodeContract(nodeId: string): NodeContract {
    return {
      nodeId,
      allowedTools: [],
      forbiddenTools: [],
      preferredTools: [],
      requiredOutputSignals: [],
      completionCriteria: {
        requiredSignals: [],
        minToolCalls: 1,
        maxRounds: 10,
        allowExplicitDone: false,
      },
      nodeGuard: {
        maxIdleRounds: 3,
        maxToolsPerRound: 8,
        maxSameToolRepeat: 5,
        enforceToolBoundary: false,
        deviationTolerance: 'soft',
      },
      version: 1,
    };
  }

  private attemptFallback(reason: string): void {
    if (!this.graph) return;
    const recovery = needsRecovery(this.graph);
    if (recovery) {
      switchToFallbackBranch(this.graph, 'retries_exceeded');
      this.resetNodeState();
    }
  }
}
