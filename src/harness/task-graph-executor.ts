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

/**
 * §19.3 — Graph 评估输出口控制。
 *   - 'full'：保留今日行为（仅 strict / off 内部使用，hint 仍经 CorrectionPort 转发）
 *   - 'metrics_only'：接管段默认；evaluateRound 不再返回 inject 文案
 *   - 'none'：完全静默；调试与单测兜底
 */
export type GraphEvaluationMode = 'full' | 'metrics_only' | 'none';

export class GraphExecutor {
  private graph: TaskGraphData | null = null;
  private contractValidator: ContractValidator | null = null;
  private deviationDetector = new DeviationDetector();
  private escalationManager = new EscalationManager();
  private failureClassifier = new FailureClassifier();
  private currentRoundToolNames: string[] = [];
  private evaluationMode: GraphEvaluationMode = 'full';
  private inTakeover = false;

  // ═══════════════════════════════════════════════
  // Graph Lifecycle
  // ═══════════════════════════════════════════════

  initGraph(opts: InitOptions): void {
    this.graph = buildGraph({ goal: opts.goal, intent: opts.intent });
    this.resetNodeState();
  }

  /**
   * §19.3 / §10 — 接管期间中途换图。
   *
   * 调用方（通常是 RecoverySupervisor 经 SupervisorRuntimeBridge）应在已通过
   * RecoverySafetyChecker / SnapshotConfidence 阈值后才调用本方法；本方法仅做
   * 数据替换与节点状态机重置，不做任何安全检查。
   *
   * 副作用：
   *   - 切换内部 `this.graph` 引用；
   *   - 重置 contractValidator / escalation / failureClassifier；
   *   - 清空当轮已采集的工具名列表。
   */
  replaceGraph(graph: TaskGraphData): void {
    this.graph = graph;
    this.resetNodeState();
    this.failureClassifier.reset();
    this.currentRoundToolNames = [];
  }

  resetGraph(): void {
    this.graph = null;
    this.contractValidator = null;
    this.escalationManager.reset();
    this.failureClassifier.reset();
    this.currentRoundToolNames = [];
    this.evaluationMode = 'full';
    this.inTakeover = false;
  }

  hasGraph(): boolean {
    return this.graph !== null;
  }

  /**
   * §19.3 — 切换 evaluateRound 的输出口。
   *
   * 接管段（adaptiveTakeover）默认 'metrics_only'：本方法被调用后
   * `evaluateRound` 将只产出 metrics-only 结果，**不再** 返回 inject hint，
   * 由 CorrectionPort 统一负责接管段的 C 类块写入（I1）。
   */
  setEvaluationMode(mode: GraphEvaluationMode): void {
    this.evaluationMode = mode;
  }

  getEvaluationMode(): GraphEvaluationMode {
    return this.evaluationMode;
  }

  /**
   * §19.3 — 与 `supervisorPhase` 同步进入 takeover；
   * 默认把评估模式压到 metrics_only，调用方仍可 `setEvaluationMode` 覆盖。
   */
  enterTakeover(): void {
    this.inTakeover = true;
    this.evaluationMode = 'metrics_only';
  }

  exitTakeover(): void {
    this.inTakeover = false;
    this.evaluationMode = 'full';
  }

  isInTakeover(): boolean {
    return this.inTakeover;
  }

  /**
   * 是否存在 pending/running 的 type='edit' 节点。
   *
   * 服务于 Execution Mode `explicit_impl` 信号判定（§2.8.4 表 8）：
   * graph 中存在尚未完成的 implement 类节点 → 进入 forced 的依据之一。
   * 与 §2.8.7 / §3.2 一致：节点 type 来自 graph 运行态，不读用户原文。
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

    // Lazy init contract validator for current node
    if (!this.contractValidator) {
      const node = getCurrentNode(this.graph);
      if (!node) return { action: 'allow' };
      const contract = this.buildNodeContract(node.id);
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
    if (this.evaluationMode === 'none') {
      this.currentRoundToolNames = [];
      return { action: 'none' };
    }

    // Contract round-end check
    const cResult = this.contractValidator.checkRoundEnd(toolCallsThisRound);
    if (cResult.action === 'force_switch') {
      this.attemptFallback(cResult.message ?? 'contract violation');
      if (this.evaluationMode === 'metrics_only') {
        this.currentRoundToolNames = [];
        return { action: 'none' };
      }
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
      if (this.evaluationMode === 'metrics_only') {
        // §19.3 / §14.0 — 接管段禁止 GraphExecutor 直接 inject；只回 metrics。
        return { action: 'none' };
      }
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
