/**
 * Runtime Resilience v2 — 增强 checkpoint schema。
 *
 * 设计目标：
 *   1. 与 v1 (TaskCheckpoint) 完全兼容：v2 是 v1 的**可选**扩展，
 *      老 checkpoint 文件按 v1 解析即可，不丢任何字段。
 *   2. 由 CheckpointEngine 在存在 sessionDir 时写入 v2 附加字段；
 *      关闭 flag 时 checkpoint 行为与现有 TaskCheckpointManager 完全一致。
 *   3. 字段全部是「快照型」描述，便于跨进程恢复执行控制状态。
 *
 * 设计文档：docs/长时间连续工作.md
 */

import type { UnifiedMessage } from '../llm/types.js';
import type {
  CompletionCondition,
} from '../harness/completion-condition.js';
import type {
  CompletionGateReason,
  CompletionStatus,
} from '../harness/completion-gate.js';
import type {
  OperationOutcome,
} from '../harness/operation-outcome.js';
import type { LoopState, StopReason } from '../harness/types.js';
import type { AcceptanceGateSnapshot } from '../harness/task-acceptance-tracker.js';
import type {
  RepoContextSnapshot,
  TaskStateSnapshot,
} from './runtime-snapshot.js';
import { LEGACY_TASK_VERIFICATION_KEYS } from './legacy-runtime-schema.js';

export type { AcceptanceGateSnapshot };
import type {
  ExecutionMode,
  ForcedDegradedTier,
  ModeDecision,
  ModeSignal,
} from './supervisor.js';

/** v2 schema 版本号；保留为字面量类型方便后续迁移判别。 */
export const RUNTIME_CHECKPOINT_VERSION = 2 as const;

/** 最近一次工具调用的精简记录（用于恢复时还原"刚做了什么"） */
export interface ToolHistoryEntry {
  /** 工具名 */
  toolName: string;
  /** 是否成功 */
  success: boolean;
  /** 调用签名（toolName + args 摘要），用于 budget 计数对齐 */
  signature: string;
  /** 时间戳（epoch ms） */
  at: number;
}

/** 最近一次失败的精简记录（用于 step-review / branch budget 恢复后立即对齐计数） */
export interface FailureHistoryEntry {
  /** 工具调用签名（与 BranchBudgetTracker 内部签名一致） */
  signature: string;
  /** 失败次数（同 signature 的累计计数） */
  count: number;
  /** 最近一条错误信息（截断） */
  lastError?: string;
  /** 最近一次失败时间戳 */
  at: number;
}

/** 最近验收失败 stderr tail 条目（与 VerificationOutputBuffer 对齐，最多 3 条） */
export interface VerificationOutputTailEntry {
  command: string;
  outputBody: string;
  at: number;
}

/** 分支预算追踪器持久化快照 */
export interface BranchBudgetSnapshot {
  /** 同一文件路径累计编辑次数 */
  fileEdits: Record<string, number>;
  /** 同一命令累计重试次数 */
  commandRetries: Record<string, number>;
  /** 同一错误签名累计计数 */
  errorRepeats: Record<string, number>;
  /** 已触发过的 recover 信号（计数，用于"分支耗尽后切策略仍失败"时不再重复) */
  recoverTriggers: number;
  /** 待消费的 write_file 豁免路径（canonical POSIX 相对路径） */
  writeBypassPaths?: string[];
  /** 待消费的验收命令重试豁免（规范化命令） */
  commandRetryBypassKeys?: string[];
}

/**
 * 运行时恢复信号 — 由 BranchBudgetTracker 或其他子系统抛出，
 * 在持久化里保留，重启后立即重新注入。
 */
export interface RecoverySignal {
  /** 触发来源：分支预算 / 步骤回顾 / 验证失败 等 */
  source: 'branch_budget' | 'step_review' | 'verification' | 'other';
  /** 用户可读的 warning 文案（注入到下一轮 user message） */
  message: string;
  /** 触发时间 */
  at: number;
  /** 是否已被消费（注入到对话）。重启后未消费的会再次注入。 */
  consumed: boolean;
}

/** L1 execution-mode state persisted in checkpoint v2. */
export interface RuntimeExecutionModeCheckpointState {
  /** Current Execution Free/Forced boundary mode. */
  executionMode: ExecutionMode;
  /** Anti-flap lock remaining after entering forced. */
  executionModeLockRemaining: number;
  /** Signals that caused the last forced entry, sorted by §2.8.8 precedence. */
  executionModeEnteredBy: ModeSignal[];
  /** Primary entry signal; mirrors executionModeEnteredBy[0] when present. */
  executionModeEnteredByPrimary?: ModeSignal;
  /** Round where forced was entered; null while free or before Batch 2 persistence. */
  executionModeEnteredAtRound: number | null;
  /** Forced degraded tier, when graph/step queue/write-intent fallback is active. */
  forcedDegradedTier?: ForcedDegradedTier;
  /** Last mode decision for observability and later resume logic. */
  lastModeDecision?: ModeDecision;
  /** Append-only pending signals captured before evaluation. */
  pendingModeSignals: ModeSignal[];
  /** I10 dwell counter; persisted later when Harness accounting is connected. */
  forcedTaskBearingRoundsSinceEntry: number;
}

/**
 * 后台任务快照（Phase 5：用于 checkpoint resume 时展示「上次还在跑的任务」）。
 *
 * 注意：恢复时**不接管真实进程**（孤儿 child 无法跨进程接管），只标记为 stale 用于
 * 提示 LLM 「上一轮启动过这些后台任务」。
 */
export interface BackgroundTaskSnapshot {
  taskId: string;
  command: string;
  label: string;
  /** 序列化时的 status；resume 后展示为 'stale' */
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'killed';
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  error: string | null;
  /** 序列化时的 totalOutputLines，让 LLM 知道任务有过多少输出 */
  totalOutputLines: number;
  /** 落盘日志路径（绝对路径），便于用户事后查看 */
  logPath: string | null;
}

/** v2 增强 checkpoint 的「附加运行时状态」部分。 */
export interface RuntimeCheckpointV2 {
  /** schema 版本号，固定为 2 */
  runtimeVersion: typeof RUNTIME_CHECKPOINT_VERSION;
  /** 当前执行步骤（来自 ExecutionPlan.activeStepId，无 plan 时为 undefined） */
  currentStepId?: string;
  /** 当前执行步骤标题（冗余字段，方便人眼检查 checkpoint 文件） */
  currentStepTitle?: string;
  /** 分支预算快照 */
  branchBudget: BranchBudgetSnapshot;
  /** 最近工具历史（最多保留 N 条） */
  recentTools: ToolHistoryEntry[];
  /** 最近失败历史 */
  recentFailures: FailureHistoryEntry[];
  /** 执行计划版本号（与 ExecutionPlan.version 对齐，便于跨进程校验） */
  planVersion?: number;
  /** 是否仍有 verification 未通过 */
  verificationPending: boolean;
  /** 待消费 / 历史 recovery signals */
  recoverySignals: RecoverySignal[];
  /** 触发本次 save 的事件（用于 telemetry / 调试） */
  lastTrigger: CheckpointSaveTrigger;
  /** 最后一次循环 stopReason（来自 Harness loopState） */
  lastStopReason?: StopReason;
  /** L1 execution-mode state. */
  executionModeState?: RuntimeExecutionModeCheckpointState;
  /** v2 写入时间 */
  v2UpdatedAt: string;
  /** 最近验收失败 stderr tail；跨 checkpoint 恢复 digest 注入 */
  verificationOutputTail?: VerificationOutputTailEntry[];
  /** 长跑任务多命令验收进度 */
  acceptanceGate?: AcceptanceGateSnapshot;
  /** Rebuild Escalation 已注入次数（跨 checkpoint 延续） */
  rebuildEscalationInjections?: number;
  /** 并行 BranchBudget 拦截指引是否已注入（每 run 一次） */
  parallelBudgetBlockHintInjected?: boolean;
  /**
   * 后台任务快照（Phase 5）：序列化当前 session 仍在跑的后台任务清单，
   * 让 checkpoint resume 后 LLM 知道「上一轮起过这些后台任务」。
   *
   * 注意：resume 不接管真实进程，仅 informational。
   */
  backgroundTasks?: BackgroundTaskSnapshot[];
}

/** Checkpoint 触发器类型 — 与 docs/长时间连续工作.md §Save Trigger 对齐 */
export type CheckpointSaveTrigger =
  | 'step_completed'
  | 'tool_failed'
  | 'verification_started'
  | 'verification_failed'
  | 'compaction'
  | 'final_draft'
  | 'manual';

/** 默认空 budget 快照（构造器初始化用） */
export function emptyBranchBudgetSnapshot(): BranchBudgetSnapshot {
  return {
    fileEdits: {},
    commandRetries: {},
    errorRepeats: {},
    recoverTriggers: 0,
  };
}

/** 默认空 v2 checkpoint（用于 first save） */
export function emptyRuntimeCheckpointV2(
  trigger: CheckpointSaveTrigger = 'manual',
): RuntimeCheckpointV2 {
  return {
    runtimeVersion: RUNTIME_CHECKPOINT_VERSION,
    branchBudget: emptyBranchBudgetSnapshot(),
    recentTools: [],
    recentFailures: [],
    verificationPending: false,
    recoverySignals: [],
    lastTrigger: trigger,
    executionModeState: emptyRuntimeExecutionModeCheckpointState(),
    v2UpdatedAt: new Date(0).toISOString(),
  };
}

/** Inert defaults: Batch 1 only persists shape, it does not alter Harness execution. */
export function emptyRuntimeExecutionModeCheckpointState(): RuntimeExecutionModeCheckpointState {
  return {
    executionMode: 'free',
    executionModeLockRemaining: 0,
    executionModeEnteredBy: [],
    executionModeEnteredAtRound: null,
    pendingModeSignals: [],
    forcedTaskBearingRoundsSinceEntry: 0,
  };
}

/**
 * 类型守卫：判断一个解析出来的 JSON 对象是否包含完整 v2 字段。
 * 用于 CheckpointEngine 在 load 时决定是走 v2 路径还是 fallback 到 v1。
 */
export function isRuntimeCheckpointV2(value: unknown): value is RuntimeCheckpointV2 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<RuntimeCheckpointV2>;
  return (
    v.runtimeVersion === RUNTIME_CHECKPOINT_VERSION
    && !!v.branchBudget
    && Array.isArray(v.recentTools)
    && Array.isArray(v.recentFailures)
    && Array.isArray(v.recoverySignals)
    && typeof v.verificationPending === 'boolean'
  );
}

/**
 * Project checkpoint v3 is a complete, storage-agnostic aggregate. RuntimeCheckpointV2
 * remains above as the read-only compatibility shape consumed by the legacy engine.
 */
export const PROJECT_CHECKPOINT_VERSION = 3 as const;

export interface ProjectCheckpointIdentity {
  checkpointId: string;
  projectId: string;
  sessionId: string;
}

/**
 * V3 deliberately does not persist the legacy verification mirror. Completion state lives
 * exclusively in completion.conditions + operationOutcomes.
 */
export type ProjectCheckpointTaskState = TaskStateSnapshot;

export interface ProjectCheckpointExecution {
  taskState: ProjectCheckpointTaskState;
  loopState: LoopState;
  currentStepId?: string;
  currentStepTitle?: string;
  lastStopReason?: StopReason;
  /** Only execution state that is safe to continue in a new process/run. */
  resumable?: ProjectCheckpointResumableExecution;
}

export interface ProjectCheckpointResumableExecution {
  branchBudget?: BranchBudgetSnapshot;
  failedToolCallSignatures?: Record<string, number>;
}

export interface ProjectCheckpointCompletion {
  conditions: CompletionCondition[];
  operationOutcomes: OperationOutcome[];
  status?: CompletionStatus;
  reason?: CompletionGateReason;
  continuationCount?: number;
  blockingSignature?: string;
}

export interface ProjectCheckpointConversation {
  messages: UnifiedMessage[];
  summary?: string;
}

export interface ProjectCheckpointWorkspace {
  root: string;
  repoContext: RepoContextSnapshot;
}

/**
 * Memory is intentionally transport-shaped: checkpoint core does not interpret provider
 * payloads, but requires each value to remain JSON-safe.
 */
export interface ProjectCheckpointMemory {
  sessionNotes?: string;
  payload?: Record<string, unknown>;
}

export interface ProjectCheckpointSnapshotMeta {
  capturedAt: string;
  trigger: CheckpointSaveTrigger;
  sequence?: number;
  parentGeneration?: number;
  runId?: string;
  roundId?: string;
  workspaceBaseline?: string;
  conversationCursor?: number;
  captureReason?: string;
  producer?: string;
}

/** Unknown extension keys are preserved as long as their values are JSON-safe. */
export type ProjectCheckpointExtensions = Record<string, unknown>;

export interface ProjectCheckpointMigration {
  sourceVersion: 1 | 2;
  targetVersion: typeof PROJECT_CHECKPOINT_VERSION;
  migratedAt: string;
  warnings: string[];
}

export interface ProjectCheckpointV3 {
  version: typeof PROJECT_CHECKPOINT_VERSION;
  identity: ProjectCheckpointIdentity;
  execution: ProjectCheckpointExecution;
  completion: ProjectCheckpointCompletion;
  conversation: ProjectCheckpointConversation;
  workspace: ProjectCheckpointWorkspace;
  memory: ProjectCheckpointMemory;
  snapshotMeta: ProjectCheckpointSnapshotMeta;
  extensions: ProjectCheckpointExtensions;
  /** null denotes a checkpoint captured natively as v3. */
  migration: ProjectCheckpointMigration | null;
}

export function isProjectCheckpointV3(value: unknown): value is ProjectCheckpointV3 {
  if (!isRecord(value) || value.version !== PROJECT_CHECKPOINT_VERSION) return false;

  const {
    identity,
    execution,
    completion,
    conversation,
    workspace,
    memory,
    snapshotMeta,
    extensions,
    migration,
  } = value;

  return isProjectIdentity(identity)
    && isProjectExecution(execution)
    && isProjectCompletion(completion)
    && isProjectConversation(conversation)
    && isProjectWorkspace(workspace)
    && isProjectMemory(memory)
    && isProjectSnapshotMeta(snapshotMeta)
    && isRecord(extensions)
    && isJsonRecord(extensions)
    && (migration === null || isProjectMigration(migration));
}

/**
 * Validate before cloning so callers cannot accidentally turn class instances, functions,
 * cycles, or other non-persistable extension values into an apparent checkpoint.
 */
export function cloneProjectCheckpointV3(checkpoint: ProjectCheckpointV3): ProjectCheckpointV3 {
  if (!isProjectCheckpointV3(checkpoint)) {
    throw new TypeError('Invalid ProjectCheckpointV3');
  }
  return structuredClone(checkpoint);
}

function isProjectIdentity(value: unknown): value is ProjectCheckpointIdentity {
  return isRecord(value)
    && isNonEmptyString(value.checkpointId)
    && isNonEmptyString(value.projectId)
    && isNonEmptyString(value.sessionId);
}

function isProjectExecution(value: unknown): value is ProjectCheckpointExecution {
  return isRecord(value)
    && isProjectTaskStateSnapshot(value.taskState)
    && isLoopState(value.loopState)
    && isOptionalString(value.currentStepId)
    && isOptionalString(value.currentStepTitle)
    && isOptionalString(value.lastStopReason)
    && (value.resumable === undefined || isProjectResumableExecution(value.resumable));
}

function isProjectCompletion(value: unknown): value is ProjectCheckpointCompletion {
  return isRecord(value)
    && Array.isArray(value.conditions)
    && value.conditions.every(isCompletionCondition)
    && Array.isArray(value.operationOutcomes)
    && value.operationOutcomes.every(isOperationOutcome)
    && (value.status === undefined || isCompletionStatus(value.status))
    && (value.reason === undefined || isCompletionGateReason(value.reason))
    && (value.continuationCount === undefined || isNonNegativeInteger(value.continuationCount))
    && isOptionalString(value.blockingSignature)
    && !Object.prototype.hasOwnProperty.call(value, 'verificationPending');
}

function isProjectResumableExecution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.branchBudget !== undefined && !isBranchBudgetSnapshot(value.branchBudget)) return false;
  if (value.failedToolCallSignatures !== undefined) {
    if (!isRecord(value.failedToolCallSignatures)) return false;
    if (!Object.values(value.failedToolCallSignatures).every(isNonNegativeInteger)) return false;
  }
  return true;
}

function isProjectConversation(value: unknown): value is ProjectCheckpointConversation {
  return isRecord(value)
    && Array.isArray(value.messages)
    && value.messages.every(isUnifiedMessage)
    && isOptionalString(value.summary);
}

function isProjectWorkspace(value: unknown): value is ProjectCheckpointWorkspace {
  return isRecord(value)
    && typeof value.root === 'string'
    && isRepoContextSnapshot(value.repoContext);
}

function isProjectMemory(value: unknown): value is ProjectCheckpointMemory {
  return isRecord(value)
    && isOptionalString(value.sessionNotes)
    && (value.payload === undefined || (isRecord(value.payload) && isJsonRecord(value.payload)));
}

function isProjectSnapshotMeta(value: unknown): value is ProjectCheckpointSnapshotMeta {
  return isRecord(value)
    && isValidDateString(value.capturedAt)
    && isCheckpointSaveTrigger(value.trigger)
    && (value.sequence === undefined || isNonNegativeInteger(value.sequence))
    && (value.parentGeneration === undefined || isNonNegativeInteger(value.parentGeneration))
    && isOptionalString(value.runId)
    && isOptionalString(value.roundId)
    && isOptionalString(value.workspaceBaseline)
    && (value.conversationCursor === undefined || isNonNegativeInteger(value.conversationCursor))
    && isOptionalString(value.captureReason)
    && isOptionalString(value.producer);
}

function isProjectMigration(value: unknown): value is ProjectCheckpointMigration {
  return isRecord(value)
    && (value.sourceVersion === 1 || value.sourceVersion === 2)
    && value.targetVersion === PROJECT_CHECKPOINT_VERSION
    && isValidDateString(value.migratedAt)
    && isStringArray(value.warnings);
}

function isProjectTaskStateSnapshot(value: unknown): value is ProjectCheckpointTaskState {
  if (!isRecord(value)) return false;
  const intents = ['question', 'inspect', 'edit', 'debug', 'test', 'refactor', 'docs'];
  const phases = ['intent', 'context', 'editing', 'verification', 'final'];
  return typeof value.goal === 'string'
    && intents.includes(String(value.intent))
    && phases.includes(String(value.phase))
    && isStringArray(value.filesRead)
    && isStringArray(value.filesChanged)
    && isStringArray(value.commandsRun)
    && LEGACY_TASK_VERIFICATION_KEYS.every(key => !Object.prototype.hasOwnProperty.call(value, key))
    && isOptionalNumberRecord(value.fileDeliverableWriteVersions)
    && isOptionalNumberRecord(value.fileDeliverableConfirmVersions);
}

function isRepoContextSnapshot(value: unknown): value is RepoContextSnapshot {
  return isRecord(value)
    && isStringArray(value.filesRead)
    && isStringArray(value.filesChanged)
    && isStringArray(value.commandsRun)
    && isStringArray(value.testCommands)
    && isStringArray(value.recentDiagnostics);
}

function isLoopState(value: unknown): value is LoopState {
  if (!isRecord(value)) return false;
  for (const key of [
    'currentRound',
    'totalInputTokens',
    'totalOutputTokens',
    'lastInputTokens',
    'lastOutputTokens',
    'totalToolCalls',
    'startTime',
  ]) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return false;
  }
  return isOptionalString(value.stopReason);
}

function isCompletionCondition(value: unknown): value is CompletionCondition {
  return isRecord(value)
    && isNonEmptyString(value.id)
    && typeof value.label === 'string'
    && typeof value.required === 'boolean'
    && ['pending', 'satisfied', 'failed', 'unverifiable'].includes(String(value.status))
    && ['user', 'graph', 'runtime'].includes(String(value.source))
    && typeof value.sourceRef === 'string'
    && isStringArray(value.evidenceRefs);
}

function isOperationOutcome(value: unknown): value is OperationOutcome {
  return isRecord(value)
    && isNonEmptyString(value.toolCallId)
    && isNonEmptyString(value.toolName)
    && ['completed', 'pending', 'failed', 'awaiting_approval'].includes(String(value.status))
    && ['observe', 'local_change', 'external_change', 'execute'].includes(String(value.effect))
    && ['low', 'high'].includes(String(value.risk))
    && ['executed', 'execution_fail', 'policy_block', 'user_denied'].includes(String(value.disposition))
    && typeof value.scope === 'string'
    && (value.receipt === undefined || isToolReceipt(value.receipt))
    && isOptionalString(value.error)
    && typeof value.at === 'number'
    && Number.isFinite(value.at)
    && (
      value.reversibility === undefined
      || ['reversible', 'compensatable', 'irreversible'].includes(String(value.reversibility))
    )
    && (value.legacySynthetic === undefined || typeof value.legacySynthetic === 'boolean');
}

function isToolReceipt(value: unknown): boolean {
  return isRecord(value)
    && isOptionalString(value.operationId)
    && isOptionalString(value.target)
    && (value.exitCode === undefined || (typeof value.exitCode === 'number' && Number.isFinite(value.exitCode)))
    && isOptionalString(value.version)
    && isOptionalString(value.summary);
}

export function isPersistableCheckpointMessage(value: unknown): value is UnifiedMessage {
  return isUnifiedMessage(value);
}

function isUnifiedMessage(value: unknown): value is UnifiedMessage {
  if (!isRecord(value) || !['system', 'user', 'assistant', 'tool'].includes(String(value.role))) {
    return false;
  }
  const contentValid = typeof value.content === 'string'
    || (
      Array.isArray(value.content)
      && value.content.every(block =>
        isRecord(block)
        && (block.type === 'text' || block.type === 'image')
        && isOptionalString(block.text)
        && isOptionalString(block.imageUrl),
      )
    );
  return contentValid
    && (value.toolCalls === undefined || (
      Array.isArray(value.toolCalls)
      && value.toolCalls.every(call =>
        isRecord(call)
        && isNonEmptyString(call.id)
        && isNonEmptyString(call.name)
        && isRecord(call.arguments)
        && isJsonRecord(call.arguments),
      )
    ))
    && isOptionalString(value.toolCallId);
}

function isCheckpointSaveTrigger(value: unknown): value is CheckpointSaveTrigger {
  return [
    'step_completed',
    'tool_failed',
    'verification_started',
    'verification_failed',
    'compaction',
    'final_draft',
    'manual',
  ].includes(String(value));
}

function isCompletionStatus(value: unknown): value is CompletionStatus {
  return [
    'completed',
    'completed_unverified',
    'paused',
    'failed',
    'interrupted',
  ].includes(String(value));
}

function isCompletionGateReason(value: unknown): value is CompletionGateReason {
  return [
    'condition_pending',
    'condition_failed',
    'condition_unverifiable',
    'operation_pending',
    'operation_failed',
    'high_risk_receipt_missing',
    'answer_not_ready',
    'settled',
    'settled_without_independent_receipt',
  ].includes(String(value));
}

function isBranchBudgetSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const key of ['fileEdits', 'commandRetries', 'errorRepeats']) {
    const counts = value[key];
    if (!isRecord(counts) || !Object.values(counts).every(isNonNegativeInteger)) return false;
  }
  return isNonNegativeInteger(value.recoverTriggers)
    && (value.writeBypassPaths === undefined || isStringArray(value.writeBypassPaths))
    && (value.commandRetryBypassKeys === undefined || isStringArray(value.commandRetryBypassKeys));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isOptionalNumberRecord(value: unknown): boolean {
  return value === undefined || (
    isRecord(value)
    && Object.values(value).every(item => typeof item === 'number' && Number.isFinite(item))
  );
}

function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isJsonRecord(value: Record<string, unknown>): boolean {
  return isJsonValue(value, new Set<object>());
}

function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every(item => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value as Record<string, unknown>).every(item => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}
