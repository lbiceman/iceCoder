import type { UnifiedMessage } from '../../llm/types.js';
import type { TaskGraph as TaskGraphData } from '../../types/task-graph.js';
import type { TaskIntent } from '../../types/runtime-snapshot.js';
import type {
  CorrectionPort,
  DeviationSignal,
  ExecutionMode,
  GlobalModePolicy,
  ResolvedSupervisorConfig,
  RuntimeRound,
  SnapshotConfidenceInput,
  SupervisorDecision,
  SupervisorEvaluateContext,
  SupervisorPhase,
  TaskContext,
  WorkspaceSnapshot,
} from '../../types/supervisor.js';
import type { RuntimeSupervisorCheckpointState } from '../../types/runtime-checkpoint.js';
import type { GraphExecutor } from '../task-graph-executor.js';
import { shouldUseTaskGraph } from '../task-graph-config.js';
import {
  getMaxSegmentRenewals,
  isSoftCheckpointEnabled,
} from '../token-budget-config.js';
import {
  CorrectionBudgetTracker,
  type CorrectionBudgetUsage,
} from './correction-budget.js';
import { MessageCorrectionPort } from './correction-port.js';
import { EventTimeline, type EventTimelineOptions } from './event-timeline.js';
import {
  GoalDriftDetector,
  type GoalDriftEvaluateInput,
} from './goal-drift-detector.js';
import type { GraphHintRoutingDecision } from './graph-hint-routing.js';
import { runComposeGraphHint, type ComposeGraphHintArgs } from './mode-gating.js';
import {
  formatDeviationSignalReason,
  PassiveObserver,
  type PassiveObserveInput,
} from './passive-observer.js';
import {
  formatBudgetExhaustionReason,
  RecoveryBudgetManager,
  type RecoveryBudgetExhaustionReason,
} from './recovery-budget-manager.js';
import { RecoveryBoundary } from './recovery-boundary.js';
import { RecoverySupervisor } from './recovery-supervisor.js';
import {
  RecoverySafetyChecker,
  type RecoverySafetyCheckInput,
  type RecoverySafetyCheckResult,
} from './recovery-safety-checker.js';
import {
  RetrospectiveGraphBuilder,
  type RetrospectiveGraphBuildInput,
} from './retrospective-graph-builder.js';
import {
  SnapshotConfidenceEvaluator,
  type SnapshotConfidenceResult,
} from './snapshot-confidence-evaluator.js';
import {
  WorkspaceStateExtractor,
  type WorkspaceStateExtractorInput,
} from './workspace-state-extractor.js';

export type { ComposeGraphHintArgs, GraphHintInput, GraphHintReasonTag } from './mode-gating.js';

export interface SupervisorRuntimeBridgeOptions extends EventTimelineOptions {}

export interface ObserveAfterToolsContext extends PassiveObserveInput {
  task: TaskContext;
  /** L2-4 GoalDriftDetector：本轮最近一条 assistant 文本，用于 bigram Jaccard。可选。 */
  lastAssistantText?: string;
}

export interface EvaluateAfterRoundContext {
  round: RuntimeRound;
  task: TaskContext;
  /** 可选额外 signals（如外部 GoalDriftDetector V2 注入）；默认使用 observer 累积值。 */
  extraSignals?: DeviationSignal[];
  riskScore: number;
  /**
   * 可选 CorrectionPort：当 evaluate 决定 takeover/handoff 时，由 supervisor 经此端口注入
   * 唯一的 C 类纠偏块。未提供则 bridge 仅写 timeline，不写 msgs（兼容仅观测路径）。
   */
  correctionPort?: CorrectionPort;
  /** 同 correctionPort：若上层只持有 msgs，可直接传 messages 自动构造 MessageCorrectionPort。 */
  messages?: UnifiedMessage[];
  /** L2-4：本轮 token 消耗（建议 outputTokens）与任务 token 总预算上限。用于 RecoveryBudgetManager。 */
  tokenUsage?: { used: number; total: number };
  /**
   * takeover 段是否计为有效恢复轮；false 时不增加 RecoveryBudgetManager 轮次计数。
   * 默认 true（兼容旧调用方）。
   */
  recoveryRoundEffective?: boolean;
}

/** L2-4：scope_creep / user_force_takeover 注入入口。 */
export type ManualTriggerSignal =
  | { type: 'scope_creep' }
  | { type: 'user_force_takeover' };

/**
 * §10 — 恢复主路径入参；调用方提供 takeover 时的工作区与目标上下文。
 *
 * 调用时机：在 `evaluateAfterRound` 决策为 `takeover` 后，由 Harness（L2-6 接入完成前
 * 也可由测试或上层服务）调用 `runRecoveryMainPath` 串联 M5→M6→M7→M8 + GraphExecutor。
 *
 * 行为概览：
 *   - confidence >= templateGraphMin 且 safety.recoverable=true → §10 一级模板图，
 *     调用 GraphExecutor.replaceGraph + enterTakeover；
 *   - confidence 不足或 safety 失败 → §19.2 二级强提示（`forcedDegradedTier=step_queue`），
 *     仅经 CorrectionPort 注入 `[System Recovery]` 单条；
 *   - 预算耗尽时由 evaluateAfterRound 已在更早环节走 `fail{checkpoint}`，本入口不重复出 fail。
 */
export interface RecoveryMainPathContext {
  round: number;
  task: TaskContext;
  signals: readonly DeviationSignal[];
  /** 由 Harness 上层提取的 RepoContext / TaskState 摘要，喂给 M5。 */
  extractInput: WorkspaceStateExtractorInput;
  /** M6 输入；调用方至少需提供 `roundsSinceExtract` / `lastVerifyPassed`。 */
  confidenceInput: Pick<SnapshotConfidenceInput, 'roundsSinceExtract' | 'lastVerifyPassed'> & {
    repoFilesChanged?: string[];
  };
  /** M7 输入；调用方可注入关键文件清单与已知文件集合。 */
  safetyInput?: Omit<RecoverySafetyCheckInput, 'snapshot'>;
  /** §10 真正执行 replaceGraph 的目标 executor；缺省时只走计算 + timeline。 */
  graphExecutor?: GraphExecutor;
  /** §14.0 唯一 inject 入口；缺省时回退到 messages → MessageCorrectionPort。 */
  correctionPort?: CorrectionPort;
  messages?: UnifiedMessage[];
}

export type RecoveryMainPathTier = 'template_graph' | 'strong_hint' | 'manual_checkpoint';

/** L2 Segment Renewal：budget 耗尽后续段时由 Harness 消费并注入 Rebuild。 */
export interface PendingSegmentRenewal {
  round: number;
  reason: RecoveryBudgetExhaustionReason;
  segmentIndex: number;
}

export interface RecoveryMainPathResult {
  tier: RecoveryMainPathTier;
  snapshot: WorkspaceSnapshot;
  confidence: SnapshotConfidenceResult;
  safety: RecoverySafetyCheckResult;
  /** tier === 'template_graph' 时返回构图结果；其他 tier 为 null。 */
  graph: TaskGraphData | null;
  /** 已标记 done 的节点 id 列表；模板图未走时为空。 */
  markedDone: string[];
  /** 触发降级的原因（仅 tier !== 'template_graph' 时填）。 */
  fallbackReason?: 'low_confidence' | 'unsafe' | 'builder_failed' | 'no_executor';
}

/**
 * L2 监管层统一入口骨架：聚合 config / GlobalPolicy / EventTimeline。
 * Harness 四钩子（§14.1）后续只经本 bridge 调用，避免 harness.ts 散落监管逻辑。
 */
export class SupervisorRuntimeBridge {
  readonly config: ResolvedSupervisorConfig;
  readonly globalPolicy: GlobalModePolicy;
  readonly eventTimeline: EventTimeline;
  readonly passiveObserver: PassiveObserver;
  readonly recoverySupervisor: RecoverySupervisor;
  readonly goalDriftDetector: GoalDriftDetector;
  readonly recoveryBudgetManager: RecoveryBudgetManager;
  readonly workspaceStateExtractor: WorkspaceStateExtractor;
  readonly snapshotConfidenceEvaluator: SnapshotConfidenceEvaluator;
  readonly recoverySafetyChecker: RecoverySafetyChecker;
  readonly retrospectiveGraphBuilder: RetrospectiveGraphBuilder;
  /** §2.6 I4 — free 段 C 类 inject 预算；通过 `createCorrectionPort` 注入到 MessageCorrectionPort。 */
  readonly correctionBudget: CorrectionBudgetTracker;
  /** §11 / §19.6 — phase × source × kind 单一硬门禁；createCorrectionPort 时注入到 port。 */
  readonly recoveryBoundary: RecoveryBoundary;

  /** P1-1 — 当前轮号缓存；createCorrectionPort / observeAfterTools / evaluateAfterRound 写入。 */
  private currentRound = 0;
  /** P0 — 最近一轮 observeAfterTools 产生的 deviation 信号；takeover 稳定窗口只看本轮。 */
  private lastRoundDeviationSignals: DeviationSignal[] = [];
  /** Segment Renewal：本 run 内已续段次数。 */
  private segmentRenewalCount = 0;
  /** 待 Harness 消费：续段后注入 Rebuild Escalation。 */
  private pendingSegmentRenewal?: PendingSegmentRenewal;

  constructor(config: ResolvedSupervisorConfig, options: SupervisorRuntimeBridgeOptions = {}) {
    this.config = config;
    this.globalPolicy = config.globalPolicy;
    this.eventTimeline = new EventTimeline(config.eventTimeline, options);
    this.passiveObserver = new PassiveObserver(config.triggers);
    this.recoverySupervisor = new RecoverySupervisor(config.params);
    this.goalDriftDetector = new GoalDriftDetector(config.goalDrift, config.triggers);
    this.recoveryBudgetManager = new RecoveryBudgetManager(config.params);
    this.workspaceStateExtractor = new WorkspaceStateExtractor();
    this.snapshotConfidenceEvaluator = new SnapshotConfidenceEvaluator(config.snapshotConfidence);
    this.recoverySafetyChecker = new RecoverySafetyChecker();
    this.retrospectiveGraphBuilder = new RetrospectiveGraphBuilder();
    this.correctionBudget = new CorrectionBudgetTracker(config.correctionBudget);
    this.recoveryBoundary = new RecoveryBoundary();
  }

  /**
   * L2-6 / §14.0 — 创建附带 I4 budget 与 §11 RecoveryBoundary 的 CorrectionPort。
   * @param round 可选轮号；写入 `currentRound` 供 boundary/budget 失败 timeline 落账。
   */
  createCorrectionPort(messages: UnifiedMessage[], round?: number): CorrectionPort {
    if (round != null) {
      this.currentRound = round;
    }
    if (!this.isActive()) {
      return new MessageCorrectionPort(messages);
    }
    return new MessageCorrectionPort(messages, {
      budget: this.correctionBudget,
      recoveryBoundary: this.recoveryBoundary,
      onBudgetRejected: ({ block, ctx }) => {
        this.eventTimeline.recordTyped('failure', {
          round: ctx.round ?? this.currentRound,
          mode: this.globalPolicy.supervisorMode,
          reason: `correction_budget_exhausted:${block.kind}`,
          payload: {
            phase: ctx.phase,
            source: ctx.source,
            budget: this.correctionBudget.snapshot(),
          },
        });
      },
      onBoundaryRejected: ({ block, ctx, reason }) => {
        this.eventTimeline.recordTyped('failure', {
          round: ctx.round ?? this.currentRound,
          mode: this.globalPolicy.supervisorMode,
          reason: `recovery_boundary_rejected:${reason}`,
          payload: {
            phase: ctx.phase,
            source: ctx.source,
            kind: block.kind,
          },
        });
      },
    });
  }

  /** L2-6 / I4 — 预算用量；供 telemetry / checkpoint 持久化使用。 */
  getCorrectionBudgetUsage(): CorrectionBudgetUsage {
    return this.correctionBudget.snapshot();
  }

  /** L2-6 — 新任务边界：复位 observer/drift/budget；Harness `run()` 入口调用。 */
  resetForNewTask(): void {
    this.passiveObserver.reset();
    this.goalDriftDetector.reset();
    this.recoveryBudgetManager.reset();
    this.correctionBudget.reset();
    this.recoverySupervisor.restoreSnapshot(undefined);
    this.lastRoundDeviationSignals = [];
    this.segmentRenewalCount = 0;
    this.pendingSegmentRenewal = undefined;
  }

  getSegmentRenewalCount(): number {
    return this.segmentRenewalCount;
  }

  consumePendingSegmentRenewal(): PendingSegmentRenewal | undefined {
    const pending = this.pendingSegmentRenewal;
    this.pendingSegmentRenewal = undefined;
    return pending;
  }

  /**
   * L2-6 / T08 — 把 supervisor 关键运行时状态打包成 checkpoint 子集，
   * 与 harness-resilience `buildSupervisorCheckpointState` 合并后写入 v2。
   *
   * 仅返回 Bridge 拥有的字段：supervisorPhase / recoverySupervisorSnapshot / timelineTail /
   * correctionBudgetUsed；executionMode 等仍由 HarnessRunState 提供。
   */
  snapshotForCheckpoint(): Pick<
    RuntimeSupervisorCheckpointState,
    'supervisorPhase' | 'recoverySupervisorSnapshot' | 'timelineTail' | 'correctionBudgetUsed' | 'segmentRenewalCount'
  > {
    const phase = this.getSupervisorPhase();
    const recoverySnapshot = this.recoverySupervisor.getSnapshot();
    const recent = this.eventTimeline.getRecentEvents();
    return {
      supervisorPhase: phase,
      recoverySupervisorSnapshot: { ...recoverySnapshot },
      timelineTail: recent.length > 0 ? recent.map(ev => ({
        ...ev,
        ...(ev.payload ? { payload: { ...ev.payload } } : {}),
      })) : undefined,
      correctionBudgetUsed: this.correctionBudget.snapshot().used,
      segmentRenewalCount: this.segmentRenewalCount,
    };
  }

  /**
   * L2-6 / T08 — checkpoint 恢复时由 Harness 调用。
   *
   * 行为：
   *   - 把 phase + RecoverySupervisor snapshot 推回内部状态机；
   *   - 把 timeline tail 推回 in-memory recent buffer（不写 sink，避免重复落 JSONL）；
   *   - 把 free 段 CorrectionBudget 计数推回，避免重启绕过 I4 上限；
   *   - 写一条 `failure:checkpoint_resumed` timeline 作为可观测标记
   *     （ModeDecisionEngine 的 `checkpoint_resumed` signal 由 Harness 单独 submit）。
   *
   * off 模式静默；shadow 模式按 non-shadow 完整恢复。
   */
  restoreFromCheckpoint(state: RuntimeSupervisorCheckpointState | undefined): void {
    if (!this.isActive() || !state) return;

    this.recoverySupervisor.restoreSnapshot(state.recoverySupervisorSnapshot ?? {
      phase: state.supervisorPhase,
    });
    this.eventTimeline.restoreRecentEvents(state.timelineTail);
    this.correctionBudget.restoreUsed(state.correctionBudgetUsed ?? 0);

    // P1 — 续跑时清累积 deviation，避免 handoff 稳定窗口被历史信号锁死；takeover 段给新 budget 周期。
    this.resetObserverSignals();
    this.lastRoundDeviationSignals = [];
    const phase = this.getSupervisorPhase();
    if (phase === 'takeover') {
      const startRound = state.recoverySupervisorSnapshot?.takeoverStartRound ?? this.currentRound;
      this.recoveryBudgetManager.beginTakeover(startRound, this.globalPolicy.supervisorMode);
    } else {
      this.recoveryBudgetManager.reset();
    }
    this.segmentRenewalCount = state.segmentRenewalCount ?? 0;
    this.pendingSegmentRenewal = undefined;

    this.eventTimeline.recordTyped('failure', {
      round: this.currentRound,
      mode: this.globalPolicy.supervisorMode,
      reason: 'checkpoint_resumed',
      payload: {
        phase: this.getSupervisorPhase(),
        budgetUsed: this.correctionBudget.snapshot().used,
        recoveryBudgetActive: this.recoveryBudgetManager.isActive(),
      },
    });
  }

  /** off 模式早退：不写入 timeline、不跑 L2 钩子副作用。 */
  isActive(): boolean {
    return this.globalPolicy.recoverySupervisorEnabled;
  }

  /**
   * L2-7 — strict 首轮 `task_graph_init` 端到端门禁。
   *
   * §I3 / §17：
   *   - **strict**：`strict.firstRoundGraph=true`（关键域第 1 轮 initGraph，强制）；
   *   - **adaptive**：`adaptiveFree.firstRoundGraph=false`（关键域**不**首轮 init，由
   *     RecoverySupervisor 在 takeover 后经 `replaceGraph` 重建）；
   *   - **off**：保留历史行为 — 等同 `shouldUseTaskGraph(intent)`，避免 cli/web 入口
   *     默认配置回归掉「关键 intent 第 1 轮看到任务图」的旧体验。
   *
   * 实际是否 init 还要由 `shouldUseTaskGraph(intent)` 做关键域过滤；本方法返回 true 只表示
   * 「按当前模式合规」。
   */
  shouldInitTaskGraphAtFirstRound(intent: TaskIntent): boolean {
    const criticalDomain = shouldUseTaskGraph(intent);
    if (!criticalDomain) return false;

    if (!this.isActive()) {
      return true;
    }

    if (this.globalPolicy.strictCapabilityBundle) {
      return this.config.params.strict.firstRoundGraph;
    }
    return this.config.params.adaptiveFree.firstRoundGraph;
  }

  /**
   * L2-7 / §14.0 / §19.6 — Graph hint 唯一收口。
   *
   * 调用方（`harness-tool-round` step warn、step block、evaluateRound force_switch）
   * 都应经此方法，禁止直接 `port.inject({ kind: 'graph_hint', ... })`：
   *   - 内部按 `decideGraphHintRouting` 决定 free 段是否 drop；
   *   - 走 inject 时 `kind='graph_hint'`、`source='supervisor'`、phase 来自调用方；
   *   - 走 inject 时同步落一条 `recover` 类 timeline（off 段不落、shadow 仍落，便于审计）。
   *
   * 返回 routing 决策，供调用方决定是否额外发 telemetry。
   */
  composeGraphHint(args: ComposeGraphHintArgs): GraphHintRoutingDecision {
    return runComposeGraphHint(this, args);
  }

  /** 监管层当前相位；off 永远返回 'free'。 */
  getSupervisorPhase(): SupervisorPhase {
    if (!this.isActive()) return 'free';
    return this.recoverySupervisor.getPhase();
  }

  /** §8.9 switch — execution mode 切换可观测性。 */
  recordExecutionModeSwitch(params: {
    round: number;
    from: ExecutionMode;
    to: ExecutionMode;
    reason: string;
  }): void {
    if (!this.isActive()) return;

    this.eventTimeline.recordTyped('switch', {
      round: params.round,
      mode: this.globalPolicy.supervisorMode,
      reason: `${params.from}->${params.to}: ${params.reason}`,
    });
  }

  /**
   * §15.8 shadow：记录「本会接管」到 timeline，不改 supervisorPhase。
   * 可选经 CorrectionPort 注入 shadow_diagnostic（仍不改 phase）。
   */
  recordShadowWouldTakeover(params: {
    round: number;
    phase: SupervisorPhase;
    reason: string;
    signals?: DeviationSignal[];
    messages?: UnifiedMessage[];
    correctionPort?: CorrectionPort;
  }): void {
    if (!this.isActive() || !this.globalPolicy.shadow) return;

    this.eventTimeline.recordTyped('shadow_diagnostic', {
      round: params.round,
      mode: this.globalPolicy.supervisorMode,
      reason: params.reason,
      payload: params.signals?.length ? { signals: params.signals } : undefined,
    });

    const port = params.correctionPort
      ?? (params.messages ? this.createCorrectionPort(params.messages, params.round) : undefined);
    port?.inject(
      { kind: 'shadow_diagnostic', content: `[Shadow] Would takeover: ${params.reason}` },
      { phase: params.phase, source: 'supervisor', round: params.round },
    );
  }

  /**
   * L2-2 / L2-4：工具轮结束后 PassiveObserver + GoalDriftDetector；仅累积 signal + timeline。
   * §19.6 free 段关闭 C 类 inject 时，由 Harness 在轮末调用本方法。
   */
  observeAfterTools(ctx: ObserveAfterToolsContext): DeviationSignal[] {
    this.currentRound = ctx.round.round;
    if (!this.isActive() || !this.globalPolicy.observerEnabled) {
      return [];
    }

    const signals = this.passiveObserver.observe(ctx);
    for (const signal of signals) {
      this.recordObserverSignal(ctx.round.round, signal);
    }

    const driftSignal = this.evaluateGoalDrift(ctx);
    if (driftSignal) {
      signals.push(driftSignal);
    }

    this.lastRoundDeviationSignals = [...signals];
    return signals;
  }

  /**
   * L2-4：scope_creep / user_force_takeover 等触发信号外部入口。
   *   - `triggers.scopeCreepEnabled` / `userForceTakeoverEnabled` 关闭时静默丢弃；
   *   - 累积到 observer 列表，evaluateAfterRound 会一并消费；
   *   - 同时写一条 `failure` 类 timeline，便于 shadow 与回归对账。
   * 返回是否成功累积（toggle off / supervisor off 时返回 false）。
   */
  submitManualTrigger(signal: ManualTriggerSignal, round: number): boolean {
    if (!this.isActive() || !this.globalPolicy.observerEnabled) return false;
    const accepted = this.passiveObserver.pushSignal(signal);
    if (accepted) {
      this.recordObserverSignal(round, signal);
    }
    return accepted;
  }

  getAccumulatedDeviationSignals(): readonly DeviationSignal[] {
    return this.passiveObserver.getAccumulated();
  }

  resetObserverSignals(): void {
    this.passiveObserver.reset();
    this.goalDriftDetector.reset();
  }

  /**
   * L2-4 GoalDriftDetector V1：评估本轮 alignment；连续 N 轮低于阈值 → 提交 `goal_drift`。
   * triggers.goalDriftEnabled 关闭时直接返回。
   */
  private evaluateGoalDrift(ctx: ObserveAfterToolsContext): DeviationSignal | undefined {
    if (!this.goalDriftDetector.isEnabled()) return undefined;

    const input: GoalDriftEvaluateInput = {
      task: ctx.task,
      toolNames: ctx.round.toolNames,
      toolSuccess: ctx.round.toolSuccess,
      hadWriteTool: ctx.round.hadWriteTool,
      lastAssistantText: ctx.lastAssistantText,
    };
    const evaluation = this.goalDriftDetector.evaluate(input);

    if (evaluation.signal && this.passiveObserver.pushSignal(evaluation.signal)) {
      this.recordObserverSignal(ctx.round.round, evaluation.signal);
      return evaluation.signal;
    }
    return undefined;
  }

  /**
   * L2-3：轮次结束后 RecoverySupervisor.evaluate 入口。
   *
   * 行为：
   *   - off：早退 continue；
   *   - shadow：computeNext 得到决策（不 commit phase 变更），decision 经 applyDecision 拦截并仅写 timeline；
   *   - non-shadow：computeNext → commit 推进 phase → applyDecision 写 timeline；
   *     若决策为 takeover/handoff，bridge 经 CorrectionPort 注入对应 C 类块（唯一 inject 路径，I1/§19.6）。
   */
  async evaluateAfterRound(ctx: EvaluateAfterRoundContext): Promise<SupervisorDecision> {
    this.currentRound = ctx.round.round;
    if (!this.isActive()) {
      return { action: 'continue' };
    }

    const phaseBefore = this.recoverySupervisor.getPhase();
    const signals = this.resolveEvaluationSignals(phaseBefore, ctx.extraSignals);
    const supervisorCtx = this.buildEvaluateContext({
      phase: phaseBefore,
      round: ctx.round,
      task: ctx.task,
      signals,
      riskScore: ctx.riskScore,
    });

    const { decision, nextSnapshot } = this.recoverySupervisor.computeNext(supervisorCtx);
    const shadow = this.globalPolicy.shadow;

    const finalDecision = shadow
      ? decision
      : this.applyBudget(decision, nextSnapshot.phase, phaseBefore, ctx);

    if (!shadow) {
      this.recoverySupervisor.commit(nextSnapshot);
      // budget side effect 已在 applyBudget 内处理。
    }

    const applied = this.applyDecision(finalDecision, phaseBefore, ctx.round.round);

    if (!shadow) {
      this.dispatchSideEffects(finalDecision, ctx);
    }

    return applied;
  }

  /** L2-4：在 takeover 段维护 RecoveryBudgetManager；耗尽时把 decision 升级为 `fail{checkpoint}`。 */
  private applyBudget(
    decision: SupervisorDecision,
    nextPhase: ReturnType<RecoverySupervisor['getPhase']>,
    phaseBefore: ReturnType<RecoverySupervisor['getPhase']>,
    ctx: EvaluateAfterRoundContext,
  ): SupervisorDecision {
    const enteringTakeover = phaseBefore !== 'takeover' && nextPhase === 'takeover';
    const stayingInTakeover = phaseBefore === 'takeover' && nextPhase === 'takeover';
    const leavingTakeover = phaseBefore === 'takeover' && nextPhase !== 'takeover';

    if (enteringTakeover) {
      this.recoveryBudgetManager.beginTakeover(ctx.round.round, this.globalPolicy.supervisorMode);
      this.recoveryBudgetManager.tickRound(ctx.round.round, ctx.recoveryRoundEffective !== false);
    } else if (stayingInTakeover) {
      this.recoveryBudgetManager.tickRound(ctx.round.round, ctx.recoveryRoundEffective !== false);
    }

    if (ctx.tokenUsage && (enteringTakeover || stayingInTakeover)) {
      this.recoveryBudgetManager.recordTokenUsage(ctx.tokenUsage.used, ctx.tokenUsage.total);
    }

    if (enteringTakeover || stayingInTakeover) {
      const evaluation = this.recoveryBudgetManager.evaluate();
      if (evaluation.extended) {
        this.recordBudgetExtension(ctx.round.round);
      }
      if (evaluation.exhausted && evaluation.reason) {
        this.recordBudgetExhaustion(evaluation.reason, ctx.round.round);

        const canRenewSegment = evaluation.reason === 'max_recovery_rounds'
          && isSoftCheckpointEnabled()
          && this.segmentRenewalCount < getMaxSegmentRenewals();

        if (canRenewSegment) {
          this.renewRecoverySegment(ctx, evaluation.reason);
          return decision;
        }

        this.recoveryBudgetManager.reset();
        return { action: 'fail', kind: 'checkpoint' };
      }
    }

    if (leavingTakeover) {
      this.recoveryBudgetManager.reset();
      this.resetObserverSignals();
      this.lastRoundDeviationSignals = [];
    }

    return decision;
  }

  /**
   * Segment Renewal — recovery rounds budget 耗尽时在同 run 内续段：
   * 重置 observer / budget 周期，保留 takeover phase，并标记 pending Rebuild inject。
   */
  private renewRecoverySegment(
    ctx: EvaluateAfterRoundContext,
    reason: RecoveryBudgetExhaustionReason,
  ): void {
    this.segmentRenewalCount += 1;
    this.resetObserverSignals();
    this.lastRoundDeviationSignals = [];

    const round = ctx.round.round;
    if (this.recoverySupervisor.getPhase() === 'takeover') {
      this.recoveryBudgetManager.beginTakeover(round, this.globalPolicy.supervisorMode);
    } else {
      this.recoveryBudgetManager.reset();
    }

    this.pendingSegmentRenewal = {
      round,
      reason,
      segmentIndex: this.segmentRenewalCount,
    };

    this.eventTimeline.recordTyped('recover', {
      round,
      mode: this.globalPolicy.supervisorMode,
      reason: `segment_renewal:${formatBudgetExhaustionReason(reason)}`,
      payload: {
        segmentIndex: this.segmentRenewalCount,
        budget: this.recoveryBudgetManager.snapshot(),
      },
    });
  }

  /**
   * P0 — free→takeover 看累积信号；takeover/handoff_pending 稳定判定只看本轮 observe 信号。
   */
  private resolveEvaluationSignals(
    phaseBefore: SupervisorPhase,
    extraSignals?: readonly DeviationSignal[],
  ): DeviationSignal[] {
    const useLastRoundOnly = phaseBefore === 'takeover' || phaseBefore === 'handoff_pending';
    const base = useLastRoundOnly
      ? this.lastRoundDeviationSignals
      : this.passiveObserver.getAccumulated();
    return mergeSignals(base, extraSignals);
  }

  /**
   * L2-5：§10 恢复主路径串联（M5 → M6 → M7 → M8 → GraphExecutor.replaceGraph）。
   *
   * 行为：
   *   - off / shadow：仅走计算路径并写 timeline（不调用 GraphExecutor.replaceGraph，
   *     不经 CorrectionPort 注入 takeover/recovery 块）；
   *   - phase !== 'takeover'：跳过，返回结果 `tier='strong_hint'` 标记错误调用时机，
   *     不抛错，便于上层在 evaluate 之后调用而无需自己核对 phase；
   *   - 一级（confidence >= templateGraphMin 且 safety.recoverable=true 且 builder 成功且
   *     graphExecutor 注入）：调用 `replaceGraph` + `enterTakeover()`，timeline 写 `recover`；
   *   - 二级（任一前置失败）：仅 timeline 写 `recover` 并经 CorrectionPort 注入一条
   *     `[System Recovery]` 的 `recovery` 块；ExecutionMode 由 ModeDecisionEngine 维持 forced，
   *     调用方自行更新 `forcedDegradedTier`（§19.7）。
   */
  runRecoveryMainPath(ctx: RecoveryMainPathContext): RecoveryMainPathResult {
    const snapshot = this.workspaceStateExtractor.extract(ctx.extractInput);
    const confidence = this.snapshotConfidenceEvaluator.evaluate({
      snapshot,
      repoFilesChanged: ctx.confidenceInput.repoFilesChanged ?? [],
      roundsSinceExtract: ctx.confidenceInput.roundsSinceExtract,
      lastVerifyPassed: ctx.confidenceInput.lastVerifyPassed,
    });
    const safety = this.recoverySafetyChecker.check({
      ...(ctx.safetyInput ?? {}),
      snapshot,
    });

    const inactive = !this.isActive();
    const shadow = this.globalPolicy.shadow;
    const phase = this.recoverySupervisor.getPhase();

    if (inactive) {
      return {
        tier: 'strong_hint',
        snapshot,
        confidence,
        safety,
        graph: null,
        markedDone: [],
        fallbackReason: 'no_executor',
      };
    }

    if (phase !== 'takeover') {
      this.recordRecoveryPathDiagnostic(ctx.round, 'not_in_takeover');
      return {
        tier: 'strong_hint',
        snapshot,
        confidence,
        safety,
        graph: null,
        markedDone: [],
        fallbackReason: 'no_executor',
      };
    }

    if (!confidence.meetsTemplateGraphThreshold) {
      return this.handleFallback({
        ctx,
        snapshot,
        confidence,
        safety,
        reason: 'low_confidence',
        shadow,
      });
    }

    if (!safety.recoverable) {
      return this.handleFallback({
        ctx,
        snapshot,
        confidence,
        safety,
        reason: 'unsafe',
        shadow,
      });
    }

    const builderInput: RetrospectiveGraphBuildInput = {
      goal: ctx.task.goal,
      intent: ctx.task.intent,
      snapshot,
      signals: ctx.signals,
    };
    const built = this.retrospectiveGraphBuilder.build(builderInput);

    if (!built.ok) {
      return this.handleFallback({
        ctx,
        snapshot,
        confidence,
        safety,
        reason: 'builder_failed',
        shadow,
      });
    }

    if (!ctx.graphExecutor) {
      // 计算成功但没有真实 executor（例如 shadow 评测或上层尚未接入），
      // 仍写 timeline 但 tier 标 manual_checkpoint 以提示调用方主动接管。
      this.recordRecoveryPathDiagnostic(ctx.round, 'no_executor');
      return {
        tier: 'strong_hint',
        snapshot,
        confidence,
        safety,
        graph: built.graph,
        markedDone: built.markedDone,
        fallbackReason: 'no_executor',
      };
    }

    if (!shadow) {
      ctx.graphExecutor.replaceGraph(built.graph);
      ctx.graphExecutor.enterTakeover();
    }

    this.eventTimeline.recordTyped('recover', {
      round: ctx.round,
      mode: this.globalPolicy.supervisorMode,
      reason: `template_graph:${built.markedDone.length}/${built.graph.mainBranch.nodeIds.length}`,
      payload: {
        snapshotId: snapshot.snapshotId,
        confidence: confidence.confidence,
        signals: built.signalsSummary,
        markedDone: built.markedDone,
      },
    });

    return {
      tier: 'template_graph',
      snapshot,
      confidence,
      safety,
      graph: built.graph,
      markedDone: built.markedDone,
    };
  }

  /** L2-4：外部（如 GraphExecutor / 工具重试路径）显式记 token 与同路径重试，便于 budget 计数。 */
  recordRecoveryTokenUsage(used: number, total: number): void {
    if (!this.isActive()) return;
    this.recoveryBudgetManager.recordTokenUsage(used, total);
  }

  recordRecoveryRetry(signature: string): void {
    if (!this.isActive()) return;
    this.recoveryBudgetManager.recordRetry(signature);
  }

  /**
   * 派发 takeover/handoff 的 CorrectionPort 写入；shadow 段不调用，由 applyDecision 已转为 continue。
   * 注：此处 takeover 块由 `RecoverySupervisor.applyTakeover` 真正落字（W7 仅在 phase=free 抑制
   * takeover 类，因此 commit 必须已发生在调用前）。
   */
  private dispatchSideEffects(decision: SupervisorDecision, ctx: EvaluateAfterRoundContext): void {
    if (decision.action !== 'takeover' && decision.action !== 'handoff') return;

    const port = resolveCorrectionPort(this, ctx);
    if (!port) return;

    if (decision.action === 'takeover') {
      this.recoverySupervisor.applyTakeover({
        round: ctx.round.round,
        reason: decision.reason,
        signals: decision.signals,
        task: ctx.task,
        correctionPort: port,
      });
      return;
    }

    this.recoverySupervisor.applyHandoff({
      round: ctx.round.round,
      task: ctx.task,
      correctionPort: port,
    });
  }

  /** 将 RecoverySupervisor 决策落 timeline；shadow 下拦截全部 phase 变更决策。 */
  applyDecision(
    decision: SupervisorDecision,
    phase: SupervisorPhase,
    round: number,
  ): SupervisorDecision {
    if (!this.isActive()) {
      return { action: 'continue' };
    }

    if (this.globalPolicy.shadow && decision.action !== 'continue') {
      this.recordShadowBlockedDecision(decision, phase, round);
      return { action: 'continue' };
    }

    this.recordDecisionEvent(decision, round);
    return decision;
  }

  /** 供 L2-3+ 直接构造 evaluate context。 */
  buildEvaluateContext(params: {
    phase: SupervisorPhase;
    round: RuntimeRound;
    task: TaskContext;
    signals: DeviationSignal[];
    riskScore: number;
  }): SupervisorEvaluateContext {
    return {
      phase: params.phase,
      mode: this.globalPolicy.supervisorMode,
      shadow: this.globalPolicy.shadow,
      round: params.round,
      signals: params.signals,
      riskScore: params.riskScore,
      task: params.task,
    };
  }

  private recordShadowBlockedDecision(
    decision: Exclude<SupervisorDecision, { action: 'continue' }>,
    phase: SupervisorPhase,
    round: number,
  ): void {
    if (decision.action === 'takeover') {
      this.recordShadowWouldTakeover({
        round,
        phase,
        reason: decision.reason,
        signals: decision.signals,
      });
      return;
    }

    this.eventTimeline.recordTyped('shadow_diagnostic', {
      round,
      mode: this.globalPolicy.supervisorMode,
      reason: formatShadowBlockedReason(decision),
      payload: { wouldAction: decision.action },
    });
  }

  /** §19.2 二级强提示：不建图，仅经 CorrectionPort 注入一条 `[System Recovery]`。 */
  private handleFallback(params: {
    ctx: RecoveryMainPathContext;
    snapshot: WorkspaceSnapshot;
    confidence: SnapshotConfidenceResult;
    safety: RecoverySafetyCheckResult;
    reason: NonNullable<RecoveryMainPathResult['fallbackReason']>;
    shadow: boolean;
  }): RecoveryMainPathResult {
    const { ctx, snapshot, confidence, safety, reason, shadow } = params;
    const reasonText = formatFallbackReason(reason, safety);

    this.eventTimeline.recordTyped('recover', {
      round: ctx.round,
      mode: this.globalPolicy.supervisorMode,
      reason: `strong_hint:${reasonText}`,
      payload: {
        snapshotId: snapshot.snapshotId,
        confidence: confidence.confidence,
        safety: safety.reasons,
      },
    });

    if (!shadow) {
      const port = ctx.correctionPort
        ?? (ctx.messages ? this.createCorrectionPort(ctx.messages, ctx.round) : undefined);
      port?.inject(
        {
          kind: 'recovery',
          content: formatStrongHintMessage(reason, ctx.signals, safety),
          preserveOnCompaction: true,
        },
        { phase: 'takeover', source: 'supervisor', round: ctx.round },
      );
    }

    return {
      tier: 'strong_hint',
      snapshot,
      confidence,
      safety,
      graph: null,
      markedDone: [],
      fallbackReason: reason,
    };
  }

  private recordRecoveryPathDiagnostic(round: number, reason: string): void {
    this.eventTimeline.recordTyped('failure', {
      round,
      mode: this.globalPolicy.supervisorMode,
      reason: `recovery_main_path_skipped:${reason}`,
    });
  }

  private recordObserverSignal(round: number, signal: DeviationSignal): void {
    const event = signal.type === 'goal_drift' ? 'drift' as const : 'failure' as const;
    this.eventTimeline.recordTyped(event, {
      round,
      mode: this.globalPolicy.supervisorMode,
      reason: formatDeviationSignalReason(signal),
      payload: { signal },
    });
  }

  private recordBudgetExhaustion(
    reason: RecoveryBudgetExhaustionReason,
    round: number,
  ): void {
    this.eventTimeline.recordTyped('failure', {
      round,
      mode: this.globalPolicy.supervisorMode,
      reason: formatBudgetExhaustionReason(reason),
      payload: { budget: this.recoveryBudgetManager.snapshot() },
    });
  }

  private recordBudgetExtension(round: number): void {
    this.eventTimeline.recordTyped('failure', {
      round,
      mode: this.globalPolicy.supervisorMode,
      reason: 'budget_extended:rounds',
      payload: { budget: this.recoveryBudgetManager.snapshot() },
    });
  }

  private recordDecisionEvent(decision: SupervisorDecision, round: number): void {
    const mode = this.globalPolicy.supervisorMode;

    switch (decision.action) {
      case 'takeover':
        this.eventTimeline.recordTyped('recover', {
          round,
          mode,
          reason: decision.reason,
          payload: decision.signals.length ? { signals: decision.signals } : undefined,
        });
        break;
      case 'handoff_pending':
      case 'handoff':
        this.eventTimeline.recordTyped('handoff', {
          round,
          mode,
          reason: decision.action,
        });
        break;
      case 'fail':
        this.eventTimeline.recordTyped(decision.kind === 'rollback' ? 'rollback' : 'failure', {
          round,
          mode,
          reason: decision.kind,
        });
        break;
      case 'continue':
        break;
    }
  }
}

export function createSupervisorRuntimeBridge(
  config: ResolvedSupervisorConfig,
  options: SupervisorRuntimeBridgeOptions = {},
): SupervisorRuntimeBridge {
  return new SupervisorRuntimeBridge(config, options);
}

function mergeSignals(
  base: readonly DeviationSignal[],
  extra?: readonly DeviationSignal[],
): DeviationSignal[] {
  if (!extra || extra.length === 0) return [...base];
  return [...base, ...extra];
}

function resolveCorrectionPort(
  bridge: SupervisorRuntimeBridge,
  ctx: EvaluateAfterRoundContext,
): CorrectionPort | undefined {
  if (ctx.correctionPort) return ctx.correctionPort;
  if (ctx.messages) return bridge.createCorrectionPort(ctx.messages, ctx.round.round);
  return undefined;
}

function formatShadowBlockedReason(decision: Exclude<SupervisorDecision, { action: 'continue' }>): string {
  switch (decision.action) {
    case 'takeover':
      return decision.reason;
    case 'handoff_pending':
      return 'would_handoff_pending';
    case 'handoff':
      return 'would_handoff';
    case 'fail':
      return `would_fail:${decision.kind}`;
  }
}

function formatFallbackReason(
  reason: NonNullable<RecoveryMainPathResult['fallbackReason']>,
  safety: RecoverySafetyCheckResult,
): string {
  switch (reason) {
    case 'low_confidence':
      return 'low_confidence';
    case 'unsafe':
      return `unsafe:${safety.humanReason}`;
    case 'builder_failed':
      return 'builder_failed';
    case 'no_executor':
      return 'no_executor';
  }
}

function formatStrongHintMessage(
  reason: NonNullable<RecoveryMainPathResult['fallbackReason']>,
  signals: readonly DeviationSignal[],
  safety: RecoverySafetyCheckResult,
): string {
  const reasonLine = reason === 'unsafe'
    ? `Reason: unsafe (${safety.humanReason})`
    : `Reason: ${reason}`;
  const signalsLine = signals.length > 0
    ? `Signals: ${signals.map(formatDeviationSignalReason).join(', ')}`
    : 'Signals: (none)';
  return [
    '[System Recovery]',
    'Supervisor cannot rebuild a template graph for takeover; switching to strong-hint mode.',
    reasonLine,
    signalsLine,
    'Execution mode stays forced; please proceed with a minimal step queue before next attempt.',
  ].join('\n');
}
