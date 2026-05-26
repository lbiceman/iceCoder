import type { ToolCall } from '../llm/types.js';
import type { TaskIntent } from './runtime-snapshot.js';

/** 产品三档监管模式；由 config.json / supervisor-config 解析，业务模块只读 GlobalModePolicy。 */
export type SupervisorMode = 'off' | 'adaptive' | 'strict';

/** 与 TaskIntent 映射；§4 细粒度域可逐步扩展，不驱动 ExecutionMode。 */
export type TaskDomain =
  | 'critical_edit'
  | 'critical_debug'
  | 'critical_test'
  | 'critical_refactor'
  | 'critical_architecture'
  | 'critical_migration'
  | 'critical_deploy'
  | 'non_critical_read'
  | 'non_critical_explain'
  | 'non_critical_docs';

/** §2.8 · 执行边界（非 SupervisorMode），后续只允许 ModeDecisionEngine 裁决。 */
export type ExecutionMode = 'free' | 'forced';

/** 运行时相位，与配置 mode 无关；见 §18。 */
export type SupervisorPhase = 'free' | 'takeover' | 'handoff_pending' | 'cooldown';

/** §3.2 Global Mode Policy：env/config 解析结果，非 per-task 判定。 */
export interface GlobalModePolicy {
  /** off -> false；adaptive / strict -> true。 */
  autoDecisionEnabled: boolean;
  /** 启动/热加载时解析出的全局产品模式。 */
  supervisorMode: SupervisorMode;
  /** 影子评测开关；off 下强制 false。 */
  shadow: boolean;
  /** strict -> forced；off/adaptive -> free。 */
  executionModeFloor: ExecutionMode;
  /** off -> false；adaptive / strict -> true。 */
  observerEnabled: boolean;
  /** off -> false；adaptive / strict -> true。 */
  modeDecisionEngineEnabled: boolean;
  /** off -> false；adaptive / strict -> true。 */
  recoverySupervisorEnabled: boolean;
  /** strict 能力包；由 config/env 合成后的全局能力标记。 */
  strictCapabilityBundle: boolean;
}

export interface ModeController {
  resolveGlobalPolicy(): GlobalModePolicy;
  /** §17 参数；来自 config，非 env 散落读取。 */
  getModeParams(): SupervisorParams;
}

/** 磁盘配置根类型；字段注释规范见 docs/双模方案2.md §15.2-§15.6。 */
export interface SupervisorConfigFile {
  /** 运行模式；由 config.json `supervisorMode` 或 supervisor-config.json `mode` 解析。 */
  mode: SupervisorMode;
  /** 影子评测：评估全跑但不改 supervisorPhase；可被 ICE_SUPERVISOR_SHADOW 覆盖。 */
  shadow: boolean;
  /** §17 三列参数。 */
  params: SupervisorParams;
  /** §9 条件三：异常触发阈值。 */
  triggers: SupervisorTriggers;
  /** §8.3 / §19.1 目标漂移。 */
  goalDrift: GoalDriftConfig;
  /** §8.5 快照可信度。 */
  snapshotConfidence: SnapshotConfidenceConfig;
  /** §2.6 I4：free 段 C 类 inject 预算。 */
  correctionBudget: CorrectionBudgetConfig;
  /** §6 风险因子权重（可选）。 */
  riskEvaluator?: RiskEvaluatorWeights;
  /** §8.9 事件时间线落盘（可选）。 */
  eventTimeline?: EventTimelineConfig;
  /** §2.8 / §8.11 Execution Free/Forced 阈值。 */
  executionMode?: ExecutionModeConfig;
}

/** 合并默认值和 env 覆盖后的有效配置。 */
export interface ResolvedSupervisorConfig extends SupervisorConfigFile {
  executionMode: ExecutionModeConfig;
  eventTimeline: EventTimelineConfig;
  globalPolicy: GlobalModePolicy;
}

export interface SupervisorParams {
  strict: ModeParams;
  /** adaptive 自由段：仅 riskThreshold + firstRoundGraph。 */
  adaptiveFree: Pick<ModeParams, 'riskThreshold' | 'firstRoundGraph'>;
  /** adaptive 接管段：supervisorPhase=takeover。 */
  adaptiveTakeover: ModeParams;
}

/** §15.3 / §17 单列参数。 */
export interface ModeParams {
  /** 关键域第 1 轮是否 initGraph；adaptive 自由段必须为 false。 */
  firstRoundGraph: boolean;
  /** 风险分 [0,1] 接管候选阈；接管后不再评估。 */
  riskThreshold: number;
  /** 单次 takeover 最大恢复轮数。 */
  maxRecoveryRounds: number;
  /** 恢复 token 占任务总预算比例上限 [0,1]。 */
  recoveryTokenRatio: number;
  /** 同路径恢复重试上限（§8.8）。 */
  maxRecoveryRetries: number;
  /** handoff 前稳定观察轮数（§12.2）。 */
  stabilityWindowRounds: number;
  /** 交还后禁止再次接管的冷却轮数（§12.3）。 */
  handoffCooldownRounds: number;
  /** GraphExecutor.evaluateRound 是否注入 msgs。 */
  evaluateRoundMode: 'full' | 'metrics_only' | 'none';
  /** 是否 checkToolCall 并送入 ToolGate。 */
  checkToolCall: boolean;
}

/** §15.4 异常触发阈值。 */
export interface SupervisorTriggers {
  toolRepeatFailMin: number;
  noProgressRoundsMin: number;
  fileLoopMin: number;
  goalDriftEnabled: boolean;
  scopeCreepEnabled: boolean;
  userForceTakeoverEnabled: boolean;
}

/** §15.5 goalDrift。 */
export interface GoalDriftConfig {
  alignmentThreshold: number;
  consecutiveRoundsBelow: number;
  llmGrayZoneLow: number;
  llmGrayZoneHigh: number;
  jaccardMinGoalOverlap?: number;
}

/** §15.5 snapshotConfidence。 */
export interface SnapshotConfidenceConfig {
  /** 低于则禁止 §19.2 一级模板图。 */
  templateGraphMin: number;
  weightGitClean?: number;
  weightSnapshotAge?: number;
  weightVerifyPassed?: number;
  weightRepoContextMatch?: number;
  weightBuildSignal?: number;
}

/** §15.5 correctionBudget。 */
export interface CorrectionBudgetConfig {
  freeSegmentMaxPerTask: number;
  shadowDiagnosticMaxPerRound?: number;
}

/** §15.5 riskEvaluator。 */
export interface RiskEvaluatorWeights {
  weightFilesChanged?: number;
  weightDependencyDepth?: number;
  weightModuleBlastRadius?: number;
  weightIrreversibleOps?: number;
  weightCompileImpact?: number;
  weightRecentFailures?: number;
}

/** §15.5 eventTimeline。 */
export interface EventTimelineConfig {
  enabled: boolean;
  persistPath: string;
  maxEventsInCheckpoint?: number;
}

/** §8.9 EventTimeline 事件类型。 */
export type SupervisorTimelineEventType =
  | 'switch'
  | 'recover'
  | 'rollback'
  | 'handoff'
  | 'failure'
  | 'drift'
  | 'timeout'
  | 'shadow_diagnostic';

/** §8.9 JSONL 落盘结构。 */
export interface RuntimeEvent {
  ts: number;
  round: number;
  mode: string;
  event: SupervisorTimelineEventType;
  reason: string;
  payload?: Record<string, unknown>;
}

export interface EventTimeline {
  record(event: Omit<RuntimeEvent, 'ts'> & { ts?: number }): void;
  getRecentEvents(limit?: number): readonly RuntimeEvent[];
}

/** §15.5 executionMode。 */
export interface ExecutionModeConfig {
  enabled: boolean;
  pendingStepsEnterThreshold: number;
  writeTargetsEnterThreshold: number;
  diffLinesEnterThreshold: number;
  stableRoundsExitThreshold: number;
  modeLockRounds: number;
  /** §2.8.12 · I10 默认 1。 */
  forcedMinDwellRounds: number;
  readonlyToolNames: string[];
}

export type TaskRiskLevel = 'L0_observation' | 'L1_minor_edit' | 'L2_structural';

export type ModeSignal =
  | 'task_graph_active'
  | 'pending_steps'
  | 'multi_write'
  | 'branch_switched'
  | 'checkpoint_resumed'
  | 'tool_failure'
  | 'recovery_pending'
  | 'large_diff'
  | 'explicit_impl'
  | 'engine_fail_safe';

/** §2.8.8 · P0（index 0）-> P7；recovery_pending 仅阻塞 exit，不参与 enter 排序。 */
export const MODE_SIGNAL_PRECEDENCE: readonly ModeSignal[] = [
  'checkpoint_resumed',
  'task_graph_active',
  'branch_switched',
  'pending_steps',
  'tool_failure',
  'multi_write',
  'large_diff',
  'explicit_impl',
] as const;

/** §2.8.11 forced 下当前退化层。 */
export type ForcedDegradedTier = 'graph' | 'step_queue' | 'write_intent';

/** §2.8.9 · runtime telemetry / HarnessStepEvent payload。 */
export interface ExecutionModeTelemetryPayload {
  executionMode: ExecutionMode;
  enteredBy: ModeSignal[];
  enteredByPrimary?: ModeSignal;
  primaryReasonHuman: string;
  round: number;
  failSafe?: boolean;
  degradedTier?: ForcedDegradedTier;
  forcedTaskBearingRoundsSinceEntry?: number;
  forcedMinDwellRounds?: number;
  exitDeniedReason?: 'mode_lock' | 'min_dwell' | 'exit_conditions';
}

export type ModeSignalSource =
  | 'graph_executor'
  | 'recovery_supervisor'
  | 'checkpoint_engine'
  | 'step_gate'
  | 'branch_budget'
  | 'tool_gate'
  | 'stop_hook';

export interface RuntimeExecutionState {
  round: number;
  taskGraphActive: boolean;
  pendingStepCount: number;
  writeTargetsThisRound: number;
  plannedWriteTargets: number;
  accumulatedDiffLines: number;
  branchSwitchedThisRound: boolean;
  checkpointResumedThisSession: boolean;
  lastToolSuccess: boolean;
  recoveryPending: boolean;
  branchDebt: number;
  stableRounds: number;
  activeGraphHasImplementNode: boolean;
  readonlyToolNames: string[];
  plannedToolNames: string[];
  forcedEntryRound: number | null;
  forcedTaskBearingRoundsSinceEntry: number;
}

export interface TaskBearingRoundOutcome {
  hadSuccessfulToolExecute: boolean;
  graphStepAdvanced: boolean;
  writeToolSucceededWithFileChange: boolean;
}

export interface ModeDecisionEngine {
  evaluate(ctx: ModeDecisionContext): ModeDecision;
  submitSignal(source: ModeSignalSource, signal: ModeSignal, payload?: Record<string, unknown>): void;
}

export interface TaskRiskClassifier {
  classify(state: RuntimeExecutionState): TaskRiskLevel;
}

export interface ModeDecisionContext {
  round: number;
  executionMode: ExecutionMode;
  executionModeLockRemaining: number;
  supervisorPhase: SupervisorPhase;
  supervisorMode: SupervisorMode;
  riskLevel: TaskRiskLevel;
  state: RuntimeExecutionState;
  signals: ModeSignal[];
}

export type ModeDecision =
  | { action: 'keep'; mode: ExecutionMode }
  | {
      action: 'enter_forced';
      reason: ModeSignal[];
      lockRounds: number;
      enteredBy: ModeSignal[];
      primaryReason: ModeSignal;
      failSafe?: boolean;
    }
  | { action: 'exit_forced'; reason: string };

export interface TaskContext {
  goal: string;
  intent: TaskIntent;
  domain: TaskDomain;
  filesChanged: string[];
  filesRead: string[];
  commandsRun: string[];
  recentFailureCount: number;
  branchBudgetTriggers: number;
}

export interface WorkspaceSnapshot {
  snapshotId: string;
  at: number;
  gitSummary: string;
  filesAdded: string[];
  filesModified: string[];
  filesDeleted: string[];
  buildSummary?: string;
  testSummary?: string;
  lintSummary?: string;
  semanticSummary?: string;
}

/** LoopState 仅持摘要，完整 snapshot 由 checkpoint/runtime 文件承载。 */
export interface WorkspaceSnapshotRef {
  snapshotId: string;
  checkpointPath?: string;
  summaryOneLine: string;
}

export type DeviationSignal =
  | { type: 'tool_repeat_fail'; count: number }
  | { type: 'no_progress'; rounds: number }
  | { type: 'file_loop'; path: string; count: number }
  | { type: 'goal_drift'; alignment: number }
  | { type: 'scope_creep' }
  | { type: 'user_force_takeover' };

export interface RuntimeRound {
  round: number;
  toolNames: string[];
  toolSuccess: boolean[];
  hadWriteTool: boolean;
}

export interface SupervisorEvaluateContext {
  phase: SupervisorPhase;
  mode: SupervisorMode;
  shadow: boolean;
  round: RuntimeRound;
  signals: DeviationSignal[];
  riskScore: number;
  task: TaskContext;
}

export type SupervisorDecision =
  | { action: 'continue' }
  | { action: 'takeover'; reason: string; signals: DeviationSignal[] }
  | { action: 'handoff_pending' }
  | { action: 'handoff' }
  | { action: 'fail'; kind: 'checkpoint' | 'rollback' };

/** §8.10 — `RecoverySupervisor.applyTakeover` 入参（V1 骨架仅经 CorrectionPort 注入接管块）。 */
export interface TakeoverContext {
  round: number;
  reason: string;
  signals: DeviationSignal[];
  task: TaskContext;
  /** L2-3 唯一向 msgs 注入 C 类纠偏的端口；后续 L2-5 反构图主路径仍复用本端口。 */
  correctionPort: CorrectionPort;
}

/** §8.10 — `RecoverySupervisor.applyHandoff` 入参；冷却由 supervisor 内部维护。 */
export interface HandoffContext {
  round: number;
  task: TaskContext;
  correctionPort?: CorrectionPort;
}

export interface RecoverySupervisor {
  evaluate(ctx: SupervisorEvaluateContext): SupervisorDecision;
  applyTakeover(ctx: TakeoverContext): void;
  applyHandoff(ctx: HandoffContext): void;
  /** 状态机当前位（observer/timeline 查询）。 */
  getPhase(): SupervisorPhase;
}

export interface SnapshotConfidenceInput {
  snapshot: WorkspaceSnapshot;
  repoFilesChanged: string[];
  roundsSinceExtract: number;
  lastVerifyPassed: boolean;
}

/** HarnessStepEvent 扩展 payload 示例。 */
export interface SupervisorStepPayload {
  phase: SupervisorPhase;
  reason?: string;
  shadowWouldTakeover?: boolean;
}

/** §2.8.9 · step: execution_mode_enter | execution_mode_exit。 */
export type ExecutionModeStepPayload = ExecutionModeTelemetryPayload;

/** §14.0 — 纠偏写入口。 */
export type CorrectionSource = 'supervisor' | 'lifecycle' | 'memory' | 'compaction';

export interface CorrectionBlock {
  kind: 'takeover' | 'recovery' | 'graph_hint' | 'shadow_diagnostic';
  content: string;
  preserveOnCompaction?: boolean;
  ephemeralFailureRecovery?: 'light' | 'evidence' | 'strong';
}

/** §14.0 — 纠偏写入口 inject 上下文。 */
export interface CorrectionInjectContext {
  phase: SupervisorPhase;
  source: CorrectionSource;
  /** 可选轮号；timeline 落账时优先于 bridge.currentRound。 */
  round?: number;
}

export interface CorrectionPort {
  inject(block: CorrectionBlock, ctx: CorrectionInjectContext): void;
}

/** §14.0 — 工具执行门禁。 */
export type ToolGateAction = 'execute' | 'skip' | 'confirm';

export interface ToolGateEntry {
  toolCallId: string;
  action: ToolGateAction;
  message?: string;
}

export interface ToolGatePlan {
  entries: ToolGateEntry[];
}

export interface ToolGate {
  decide(calls: ToolCall[], ctx: GateContext): ToolGatePlan;
}

export interface GateContext {
  phase: SupervisorPhase;
  mode: SupervisorMode;
  /** §2.8 · Forced 下 step gate / graphHints 生效。 */
  executionMode: ExecutionMode;
  graphHints: Array<{ toolName: string; action: 'allow' | 'warn' | 'block'; message?: string }>;
}
