/**
 * TaskGraph Executor — 将 TaskGraph 集成到 Harness 循环的桥梁。
 *
 * 职责：
 *   1. 持有 TaskGraph 实例
 *   2. 管理 ContractValidator / DeviationDetector / EscalationManager
 *   3. 提供 Harness 循环所需的注入点（节点上下文、工具约束、轮次评估、游标推进）
 *
 * 依赖：Phase 1 (types), Phase 2 (task-graph), Phase 3 (builder), Phase 4 (review)
 */

import type { TaskGraph as TaskGraphData, NodeContract, OutputSignal, TaskNode } from '../types/task-graph.js';
import type { TaskIntent, TaskPhase } from '../types/runtime-snapshot.js';
import { buildGraph } from './task-graph-builder.js';
import { isNeutralAgentTool } from './agents/task-tool.js';
import {
  createTaskGraph,
  getCurrentNode,
  startCurrentNode,
  completeCurrentNode,
  advanceCursor,
  markGraphDone,
  markGraphFailed,
  snapshotForMode,
  toSnapshot,
  applySnapshot,
  switchToFallbackBranch,
  syncCursorToTaskPhase as alignGraphCursorToPhase,
} from './task-graph.js';
import {
  ContractValidator,
  DeviationDetector,
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
  action: 'none' | 'block' | 'force_switch';
  message?: string;
  fallbackActivated?: boolean;
}

export interface AdvanceResult {
  advanced: boolean;
  graphDone: boolean;
  nextNodeTitle?: string;
}

export interface SyncCursorResult {
  changed: boolean;
  view?: TaskGraphView;
  nodeId?: string;
  nodeIndex?: number;
}

export class GraphExecutor {
  private graph: TaskGraphData | null = null;
  private contractValidator: ContractValidator | null = null;
  private deviationDetector = new DeviationDetector();
  private escalationManager = new EscalationManager();
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
    this.currentRoundToolNames = [];
  }

  hasGraph(): boolean {
    return this.graph !== null;
  }

  /**
   * 是否存在 pending/running 的 type='edit' 节点。
   *
   * 图里还有未完成的 implement 节点时，可作为进入 forced 的依据。
   * 节点 type 来自图的运行态，不读用户原文。
   */
  hasPendingImplementNode(): boolean {
    if (!this.graph) return false;
    for (const node of Object.values(this.graph.nodes)) {
      if (node.type === 'edit' && (node.status === 'pending' || node.status === 'running')) {
        return true;
      }
    }
    return false;
  }

  /** 供 task_graph_init 推送步骤列表（实现/新增/创建等 edit 建图共用） */
  toView(): TaskGraphView | null {
    if (!this.graph) return null;
    return taskGraphToView(this.graph);
  }

  isTerminal(): boolean {
    return this.graph?.status === 'done' || this.graph?.status === 'failed';
  }

  /** Harness 强制 stop 闸门：仅 graph 成功完成时触发，不含 failed。 */
  isGraphDoneForHarnessStop(): boolean {
    return this.graph?.status === 'done';
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

  checkToolCall(toolName: string, opts: { track?: boolean } = {}): ToolCheckResult {
    const track = opts.track ?? true;
    if (!this.graph) return { action: 'allow' };
    // task 是中性工具：不推进、不偏离、不计入节点合约
    if (isNeutralAgentTool(toolName)) return { action: 'allow' };

    // Lazy init contract validator for current node
    if (!this.contractValidator) {
      const node = getCurrentNode(this.graph);
      if (!node) return { action: 'allow' };
      const contract = this.buildNodeContract(node);
      this.contractValidator = new ContractValidator(contract);
    }

    const result = this.contractValidator.checkBeforeToolCall(toolName, { track });
    if (track) {
      this.currentRoundToolNames.push(toolName);
    }

    // Deviation check
    if (track && result.action !== 'block') {
      const node = getCurrentNode(this.graph)!;
      const devResult = this.deviationDetector.detect({
        toolNames: [...this.currentRoundToolNames],
        allowedTools: node.suggestedTools ?? [],
        nodePhase: node.phase,
        nodeGuard: { maxSameToolRepeat: 3 },
      });
      if (devResult.deviated && devResult.severity === 'hard') {
        const hint = 'message' in devResult.correction ? devResult.correction.message : devResult.description;
        return { action: 'block', message: hint };
      }
    }

    const action = result.action === 'force_switch' ? 'block' : result.action;
    return { action, message: result.message };
  }

  recordToolResult(toolName: string, success: boolean, signal?: OutputSignal): void {
    if (!this.contractValidator || isNeutralAgentTool(toolName)) return;
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
      const fallbackActivated = this.attemptFallback(cResult.message ?? 'contract violation');
      return { action: 'force_switch', message: cResult.message, fallbackActivated };
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

      if (!devResult.deviated) {
        this.currentRoundToolNames = [];
        return { action: 'none' };
      }
      const severity = devResult.severity;
      const esc = this.escalationManager.evaluate(severity, node.id);

      let fallbackActivated: boolean | undefined;
      if (esc.action === 'force_switch') {
        fallbackActivated = this.attemptFallback(esc.message ?? 'escalation');
      }

      this.currentRoundToolNames = [];
      return { action: esc.action, message: esc.message, fallbackActivated };
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

  /**
   * 工具轮结束后，将游标与 TaskState.phase 对齐并返回更新后的面板视图。
   */
  syncCursorToTaskPhase(taskPhase: TaskPhase): SyncCursorResult {
    if (!this.graph) return { changed: false };

    const result = alignGraphCursorToPhase(this.graph, taskPhase);
    if (!result.changed) return { changed: false };

    this.resetNodeState();
    return {
      changed: true,
      view: taskGraphToView(this.graph),
      nodeId: result.currentNodeId,
      nodeIndex: this.graph.cursor.nodeIndex,
    };
  }

  // ═══════════════════════════════════════════════
  // Snapshot
  // ═══════════════════════════════════════════════

  toSnapshot(): TaskGraphSnapshot | null {
    if (!this.graph) return null;
    return toSnapshot(this.graph);
  }

  /** 模式决策用：一次遍历同时给出快照、未完成步数和 implement 节点。 */
  readModeSnapshot(): {
    snapshot: TaskGraphSnapshot | null;
    pendingStepCount: number;
    hasPendingImplementNode: boolean;
  } {
    if (!this.graph) {
      return { snapshot: null, pendingStepCount: 0, hasPendingImplementNode: false };
    }
    return snapshotForMode(this.graph);
  }

  applySnapshot(snapshot: TaskGraphSnapshot): void {
    if (!this.graph) return;
    applySnapshot(this.graph, snapshot);
  }

  // ═══════════════════════════════════════════════
  // Internals
  // ═══════════════════════════════════════════════

  private resetNodeState(): void {
    this.contractValidator = null;
    this.escalationManager.reset();
    this.currentRoundToolNames = [];
  }

  private buildNodeContract(node: TaskNode): NodeContract {
    return {
      nodeId: node.id,
      allowedTools: [...(node.suggestedTools ?? [])],
      forbiddenTools: ['delete_file'],
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

  private attemptFallback(reason: string): boolean {
    if (!this.graph) return false;
    // force_switch 时当前节点通常仍是 running，先判失败再切分支
    const node = getCurrentNode(this.graph);
    if (node && node.status !== 'failed' && node.status !== 'done' && node.status !== 'skipped') {
      completeCurrentNode(this.graph, reason);
    }
    if (switchToFallbackBranch(this.graph, 'retries_exceeded')) {
      startCurrentNode(this.graph);
      this.resetNodeState();
      return true;
    }
    markGraphFailed(this.graph, reason);
    console.warn(`[task-graph] 无可用 fallback，停止图执行：${reason}`);
    return false;
  }
}
