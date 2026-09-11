/**
 * CheckpointEngine — Runtime Resilience v2 增强 checkpoint 引擎。
 *
 * 设计目标：
 *   1. **完全向后兼容** v1 (TaskCheckpoint)：v2 只是在 v1 的同一文件里
 *      额外加入 `runtimeV2` 字段；老进程读 v1 字段，新进程读 v2 字段；
 *      老的 checkpoint 文件没有 `runtimeV2` 也能正常 load。
 *   2. **附加不破坏**：不替换 TaskCheckpointManager，而是包装它；
 *      Harness 仍然使用 TaskCheckpointManager.save() 写入 v1 字段；
 *      CheckpointEngine 负责合并写入 v2 附加字段。
 *   3. **默认始终开启**：与 Execution Transparency Layer 一致，不再通过环境变量关闭；
 *      无 `sessionDir` 时仍不会创建引擎（无可写 checkpoint 路径）。
 *
 * 持久化 trigger（来自 docs/长时间连续工作.md §Save Trigger）：
 *   - step completed / tool failed / verification started / verification failed
 *   - compaction / final draft
 *
 * 设计文档：docs/长时间连续工作.md §Part 3
 */

import type { TaskGraphSnapshot, GraphMetrics, GraphSession } from '../types/task-graph.js';
import type { TaskCheckpoint } from './checkpoint.js';
import {
  RUNTIME_CHECKPOINT_VERSION,
  isRuntimeCheckpointV2,
  emptyRuntimeCheckpointV2,
  emptyRuntimeExecutionModeCheckpointState,
  isProjectCheckpointV3,
  cloneProjectCheckpointV3,
  type RuntimeCheckpointV2,
  type RuntimeExecutionModeCheckpointState,
  type CheckpointSaveTrigger,
  type ToolHistoryEntry,
  type FailureHistoryEntry,
  type RecoverySignal,
  type VerificationOutputTailEntry,
  type ProjectCheckpointV3,
} from '../types/runtime-checkpoint.js';
import { BranchBudgetTracker } from './branch-budget.js';
import { ProjectCheckpointStore } from './project-checkpoint-store.js';
import { adaptLegacyCheckpoint } from './legacy-checkpoint-adapter.js';

/** 增强 checkpoint 在磁盘上的存储壳子 —— 与 TaskCheckpoint(v1) 共享同一个 JSON。 */
export interface CombinedCheckpointFile extends TaskCheckpoint {
  /** v2 附加字段（v1 进程读到时会忽略，不影响兼容） */
  runtimeV2?: RuntimeCheckpointV2;
  /** TaskGraph 快照（Phase 6） */
  taskGraph?: TaskGraphSnapshot;
  /** TaskGraph 指标（Phase 6） */
  graphMetrics?: GraphMetrics;
  /** TaskGraph 会话边界（Phase 6） */
  graphSession?: GraphSession;
}

/** Save 时调用方传入的「最新运行时状态」 */
export interface CheckpointSaveInput {
  trigger: CheckpointSaveTrigger;
  /** 当前执行步骤信息（来自 ExecutionPlanTracker.getPlan().activeStepId） */
  currentStepId?: string;
  currentStepTitle?: string;
  /** 分支预算 tracker；engine 调用 .snapshot() 持久化 */
  branchBudget?: BranchBudgetTracker;
  /** 增量的 recent tool 记录（engine 内部自动累加 / 截断） */
  appendTool?: ToolHistoryEntry;
  /** 增量的 recent failure 记录 */
  appendFailure?: FailureHistoryEntry;
  /** 待注入的 recovery signal（新触发的） */
  appendRecoverySignal?: RecoverySignal;
  /** ExecutionPlan，可选（仅用于读 plan.version） */
  plan?: any; // Phase 11: ExecutionPlan type removed
  /** Harness loop 当前 stopReason（如果已停止） */
  lastStopReason?: TaskCheckpoint['stopReason'];
  /** TaskGraph 快照（Phase 6） */
  taskGraphSnapshot?: TaskGraphSnapshot;
  /** TaskGraph 指标（Phase 6） */
  graphMetrics?: GraphMetrics;
  /** TaskGraph 会话边界（Phase 6） */
  graphSession?: GraphSession;
  /** L1 execution-mode snapshot. */
  executionModeState?: RuntimeExecutionModeCheckpointState;
  /** 最近验收失败 stderr tail（VerificationOutputBuffer.snapshot） */
  verificationOutputTail?: VerificationOutputTailEntry[];
  /** Rebuild Escalation 已注入次数 */
  rebuildEscalationInjections?: number;
  /** 并行 BranchBudget 拦截指引是否已注入 */
  parallelBudgetBlockHintInjected?: boolean;
}

/** 最大保留条目 */
const MAX_RECENT_TOOLS = 20;
const MAX_RECENT_FAILURES = 10;
const MAX_RECOVERY_SIGNALS = 8;

/**
 * §2.8 / T12 — forced 段比 free 段需要更激进的 checkpoint：
 * 包含 step_completed / verification_started 这类 free 段允许跳过的触发器。
 * free 段保留原有触发器集合，避免在「轻读取」任务里频繁落盘。
 */
const FREE_PERSIST_TRIGGERS: ReadonlySet<CheckpointSaveTrigger> = new Set([
  'tool_failed',
  'verification_failed',
  'compaction',
  'final_draft',
]);

const FORCED_EXTRA_TRIGGERS: ReadonlySet<CheckpointSaveTrigger> = new Set([
  'step_completed',
  'verification_started',
]);

/** 是否启用 Runtime Resilience v2（始终为 true，与 `isExecutionPlanEnabled` 策略一致） */
export function isResilienceV2Enabled(): boolean {
  return true;
}

/**
 * 增强 checkpoint 引擎。
 *
 * 用法：
 *   const engine = new CheckpointEngine(sessionDir, sessionId);
 *   await engine.save({ trigger: 'tool_failed', branchBudget, ... });
 *   const restored = await engine.loadV2();   // null 则回退到 v1
 */
export class CheckpointEngine {
  readonly checkpointPath: string;
  private readonly projectStore: ProjectCheckpointStore;
  /** 内存中保留的 v2 累积状态（save 之间增量更新） */
  private v2State: RuntimeCheckpointV2 = emptyRuntimeCheckpointV2();
  /** §2.8 / T12 — forced 段是否启用更积极的 checkpoint policy。 */
  private forcedPolicyActive = false;
  /** Runtime Restore / in-flight tool batches forbid durable snapshots. */
  private restoreLock = false;

  constructor(sessionDir: string, sessionId = 'default') {
    this.projectStore = new ProjectCheckpointStore({ sessionDir, sessionId });
    this.checkpointPath = this.projectStore.checkpointPath;
  }

  /** 暴露内存中的 v2 状态（测试 / 调试用） */
  getV2State(): RuntimeCheckpointV2 {
    return cloneV2(this.v2State);
  }

  /** §2.8 / T12 — 启停 forced 段强制策略；调用方按 ExecutionMode gate。 */
  setForcedPolicy(active: boolean): void {
    this.forcedPolicyActive = active;
  }

  isForcedPolicyActive(): boolean {
    return this.forcedPolicyActive;
  }

  /** Runtime Restore 期间锁定：禁止 save / 创建新 checkpoint。 */
  setRestoreLock(locked: boolean): void {
    this.restoreLock = locked;
  }

  setToolExecutionLock(locked: boolean): void {
    this.projectStore.setPersistBlocked(locked);
  }

  isRestoreLocked(): boolean {
    return this.restoreLock;
  }

  /**
   * Apply runtime updates without writing. Used to coalesce a tool batch into one persist.
   */
  stage(input: CheckpointSaveInput): RuntimeCheckpointV2 {
    this.applyInput(input);
    return cloneV2(this.v2State);
  }

  /**
   * Load v2 memory state from a captured aggregate. Accepts V3 or a legacy combined file.
   */
  loadFromCombined(combined: CombinedCheckpointFile | ProjectCheckpointV3): RuntimeCheckpointV2 | null {
    const v2 = resilienceFromAggregate(combined);
    if (!v2) {
      this.v2State = emptyRuntimeCheckpointV2();
      return null;
    }
    this.v2State = cloneV2(v2);
    return cloneV2(this.v2State);
  }

  /**
   * 给定保存触发器，返回是否应在当前 policy 下真实落盘。
   * free 段：仅落 tool_failed / verification_failed / compaction / final_draft。
   * forced 段：额外覆盖 step_completed / verification_started。
   * 调用方仍可以无条件 save()——本方法用于上层 gating，避免不必要的磁盘开销。
   */
  shouldPersistOnTrigger(trigger: CheckpointSaveTrigger): boolean {
    if (FREE_PERSIST_TRIGGERS.has(trigger)) return true;
    return this.forcedPolicyActive && FORCED_EXTRA_TRIGGERS.has(trigger);
  }

  /**
   * 加载现有 checkpoint 文件并尝试解析 v2 字段。
   *
   * - 文件不存在 / 解析失败 → 返回 null
   * - 文件存在但只有 v1 字段 → 返回 null（调用方再走 TaskCheckpointManager.loadActive）
   * - 文件存在且 runtimeV2 schema 合法 → 返回 v2 并把它装载到内存
   */
  async loadV2(): Promise<RuntimeCheckpointV2 | null> {
    try {
      const project = await this.projectStore.load();
      if (!project) return null;
      const v2 = resilienceFromAggregate(project);
      if (!v2) {
        this.v2State = emptyRuntimeCheckpointV2();
        return null;
      }
      this.v2State = cloneV2(v2);
      return cloneV2(this.v2State);
    } catch {
      return null;
    }
  }

  /** @deprecated Combined v1+v2 files are adapted through ProjectCheckpointStore.load. */
  async loadCombined(): Promise<CombinedCheckpointFile | null> {
    const project = await this.projectStore.load();
    return project ? v3ToCombinedCompatibility(project) : null;
  }

  /**
   * 合并保存：把 v2 附加字段写回到现有 checkpoint 文件。
   *
   * **不会清空** TaskCheckpointManager.save() 写入的 v1 字段；
   * 如果文件还不存在（v1 尚未写过），自动建立一个最小占位（只含 runtimeV2）。
   */
  async save(input: CheckpointSaveInput): Promise<RuntimeCheckpointV2> {
    this.applyInput(input);
    if (this.restoreLock || this.projectStore.isPersistBlocked()) {
      return cloneV2(this.v2State);
    }

    const loaded = this.projectStore.latest() ?? await this.projectStore.load();
    if (!loaded && await this.projectStore.hasDurableFile()) {
      // An unreadable existing file must not be replaced with an empty stub.
      return cloneV2(this.v2State);
    }
    const aggregate = loaded ?? adaptLegacyCheckpoint(this.buildMinimalV1Stub(), {
      sessionId: pathSessionId(this.checkpointPath),
      projectId: this.checkpointPath,
      capturedAt: this.v2State.v2UpdatedAt,
    });
    const next = cloneProjectCheckpointV3(aggregate);
    next.migration = null;
    next.snapshotMeta.capturedAt = this.v2State.v2UpdatedAt;
    next.snapshotMeta.trigger = input.trigger;
    next.snapshotMeta.producer = 'checkpoint-engine';
    if (this.v2State.currentStepId) next.execution.currentStepId = this.v2State.currentStepId;
    if (this.v2State.currentStepTitle) next.execution.currentStepTitle = this.v2State.currentStepTitle;
    if (this.v2State.lastStopReason !== undefined) {
      next.execution.lastStopReason = this.v2State.lastStopReason;
    }
    next.execution.resumable = {
      ...(next.execution.resumable ?? {}),
      branchBudget: this.v2State.branchBudget,
    };
    next.extensions.runtimeResilience = durableResilienceState(this.v2State);
    if (input.taskGraphSnapshot !== undefined) next.extensions.taskGraph = input.taskGraphSnapshot;
    if (input.graphMetrics !== undefined) next.extensions.graphMetrics = input.graphMetrics;
    if (input.graphSession !== undefined) next.extensions.graphSession = input.graphSession;
    await this.projectStore.save(next);

    return cloneV2(this.v2State);
  }

  /**
   * 把 input 累加到内存 v2 state。纯函数式更新，方便测试。
   */
  private applyInput(input: CheckpointSaveInput): void {
    const state = this.v2State;

    state.lastTrigger = input.trigger;
    state.v2UpdatedAt = new Date().toISOString();

    if (input.currentStepId !== undefined) state.currentStepId = input.currentStepId;
    if (input.currentStepTitle !== undefined) state.currentStepTitle = input.currentStepTitle;
    if (input.lastStopReason !== undefined) state.lastStopReason = input.lastStopReason;
    if (input.plan?.version !== undefined) state.planVersion = input.plan.version;
    if (input.executionModeState) {
      state.executionModeState = cloneExecutionModeState(input.executionModeState);
    }
    if (input.verificationOutputTail !== undefined) {
      state.verificationOutputTail = input.verificationOutputTail.map(entry => ({ ...entry }));
    }
    if (input.rebuildEscalationInjections !== undefined) {
      state.rebuildEscalationInjections = input.rebuildEscalationInjections;
    }
    if (input.parallelBudgetBlockHintInjected !== undefined) {
      state.parallelBudgetBlockHintInjected = input.parallelBudgetBlockHintInjected;
    }

    if (input.branchBudget) {
      state.branchBudget = input.branchBudget.snapshot();
    }

    if (input.appendTool) {
      state.recentTools.push(input.appendTool);
      if (state.recentTools.length > MAX_RECENT_TOOLS) {
        state.recentTools = state.recentTools.slice(-MAX_RECENT_TOOLS);
      }
    }

    if (input.appendFailure) {
      // 同签名失败合并：更新 count 与 lastError，不重复入列
      const idx = state.recentFailures.findIndex(f => f.signature === input.appendFailure!.signature);
      if (idx >= 0) {
        state.recentFailures[idx] = {
          ...state.recentFailures[idx],
          count: Math.max(state.recentFailures[idx].count, input.appendFailure.count),
          lastError: input.appendFailure.lastError ?? state.recentFailures[idx].lastError,
          at: input.appendFailure.at,
        };
      } else {
        state.recentFailures.push(input.appendFailure);
      }
      if (state.recentFailures.length > MAX_RECENT_FAILURES) {
        state.recentFailures = state.recentFailures.slice(-MAX_RECENT_FAILURES);
      }
    }

    if (input.appendRecoverySignal) {
      state.recoverySignals.push(input.appendRecoverySignal);
      if (state.recoverySignals.length > MAX_RECOVERY_SIGNALS) {
        state.recoverySignals = state.recoverySignals.slice(-MAX_RECOVERY_SIGNALS);
      }
    }
  }

  /** 标记一组 recoverySignals 为已消费（注入到对话后调用，避免重启时重复注入） */
  markRecoverySignalsConsumed(predicate: (s: RecoverySignal) => boolean): void {
    for (const sig of this.v2State.recoverySignals) {
      if (predicate(sig)) sig.consumed = true;
    }
  }

  /** 返回未消费的 recovery signals（用于重启后重新注入） */
  pendingRecoverySignals(): RecoverySignal[] {
    return this.v2State.recoverySignals.filter(s => !s.consumed);
  }

  /**
   * 新用户消息：丢弃未消费 recovery signals，避免跨 run 重复注入对话。
   * checkpoint 仍会持久化历史条目，但标记 consumed 后 pendingRecoverySignals 为空。
   */
  discardPendingRecoverySignals(): void {
    for (const sig of this.v2State.recoverySignals) {
      if (!sig.consumed) sig.consumed = true;
    }
  }

  /** 重置内存 v2 状态（任务切换时调用） */
  resetMemory(): void {
    this.v2State = emptyRuntimeCheckpointV2();
  }

  private buildMinimalV1Stub(): TaskCheckpoint {
    const now = new Date().toISOString();
    return {
      version: 1,
      taskId: 'v2-stub',
      status: 'running',
      userGoal: '',
      phase: 'intent',
      taskState: {
        goal: '',
        intent: 'question',
        phase: 'intent',
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
      },
      repoContext: {
        filesRead: [],
        filesChanged: [],
        commandsRun: [],
        testCommands: [],
        recentDiagnostics: [],
      },
      failedToolCalls: [],
      messageCount: 0,
      loop: {
        currentRound: 0,
        totalToolCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
      },
      createdAt: now,
      updatedAt: now,
    };
  }
}

function resilienceFromAggregate(input: unknown): RuntimeCheckpointV2 | null {
  if (isProjectCheckpointV3(input)) {
    return resilienceFromDurable(input.extensions.runtimeResilience);
  }
  if (input && typeof input === 'object' && isRuntimeCheckpointV2((input as CombinedCheckpointFile).runtimeV2)) {
    const v2 = (input as CombinedCheckpointFile).runtimeV2!;
    return {
      ...cloneV2(v2),
      verificationPending: false,
      acceptanceGate: undefined,
    };
  }
  return null;
}

function resilienceFromDurable(durable: unknown): RuntimeCheckpointV2 | null {
  if (!durable || typeof durable !== 'object' || Array.isArray(durable)) return null;
  const record = durable as Record<string, unknown>;
  if (record.runtimeVersion !== undefined && record.runtimeVersion !== RUNTIME_CHECKPOINT_VERSION) {
    return null;
  }
  if (!record.branchBudget || !Array.isArray(record.recentTools) || !Array.isArray(record.recentFailures)) {
    return null;
  }
  return cloneV2({
    ...emptyRuntimeCheckpointV2(),
    ...(durable as Partial<RuntimeCheckpointV2>),
    runtimeVersion: RUNTIME_CHECKPOINT_VERSION,
    verificationPending: false,
    acceptanceGate: undefined,
  });
}

function v3ToCombinedCompatibility(project: ProjectCheckpointV3): CombinedCheckpointFile {
  const legacy = project.extensions.legacyApi;
  const compat = legacy !== null && typeof legacy === 'object' && !Array.isArray(legacy)
    ? legacy as Record<string, unknown>
    : {};
  return {
    version: 1,
    taskId: project.identity.checkpointId,
    status: ['running', 'paused', 'completed', 'failed', 'aborted'].includes(String(compat.status))
      ? compat.status as TaskCheckpoint['status']
      : 'paused',
    userGoal: typeof compat.userGoal === 'string' ? compat.userGoal : project.execution.taskState.goal,
    phase: project.execution.taskState.phase,
    taskState: project.execution.taskState,
    repoContext: project.workspace.repoContext,
    failedToolCalls: Array.isArray(compat.failedToolCalls)
      ? compat.failedToolCalls.filter((value): value is string => typeof value === 'string')
      : [],
    stopReason: project.execution.lastStopReason,
    messageCount: project.conversation.messages.length,
    loop: {
      currentRound: project.execution.loopState.currentRound,
      totalToolCalls: project.execution.loopState.totalToolCalls,
      totalInputTokens: project.execution.loopState.totalInputTokens,
      totalOutputTokens: project.execution.loopState.totalOutputTokens,
    },
    createdAt: typeof compat.createdAt === 'string' ? compat.createdAt : project.snapshotMeta.capturedAt,
    updatedAt: typeof compat.updatedAt === 'string' ? compat.updatedAt : project.snapshotMeta.capturedAt,
    runtimeV2: resilienceFromAggregate(project) ?? undefined,
    ...(project.extensions.taskGraph ? { taskGraph: project.extensions.taskGraph as CombinedCheckpointFile['taskGraph'] } : {}),
    ...(project.extensions.graphMetrics ? { graphMetrics: project.extensions.graphMetrics as CombinedCheckpointFile['graphMetrics'] } : {}),
    ...(project.extensions.graphSession ? { graphSession: project.extensions.graphSession as CombinedCheckpointFile['graphSession'] } : {}),
  };
}

function cloneV2(v: RuntimeCheckpointV2): RuntimeCheckpointV2 {
  return {
    runtimeVersion: RUNTIME_CHECKPOINT_VERSION,
    currentStepId: v.currentStepId,
    currentStepTitle: v.currentStepTitle,
    branchBudget: {
      fileEdits: { ...v.branchBudget.fileEdits },
      commandRetries: { ...v.branchBudget.commandRetries },
      errorRepeats: { ...v.branchBudget.errorRepeats },
      recoverTriggers: v.branchBudget.recoverTriggers,
      writeBypassPaths: v.branchBudget.writeBypassPaths
        ? [...v.branchBudget.writeBypassPaths]
        : undefined,
      commandRetryBypassKeys: v.branchBudget.commandRetryBypassKeys
        ? [...v.branchBudget.commandRetryBypassKeys]
        : undefined,
    },
    recentTools: v.recentTools.map(t => ({ ...t })),
    recentFailures: v.recentFailures.map(f => ({ ...f })),
    planVersion: v.planVersion,
    verificationPending: v.verificationPending,
    recoverySignals: v.recoverySignals.map(s => ({ ...s })),
    lastTrigger: v.lastTrigger,
    lastStopReason: v.lastStopReason,
    executionModeState: v.executionModeState ? cloneExecutionModeState(v.executionModeState) : undefined,
    verificationOutputTail: v.verificationOutputTail?.map(entry => ({ ...entry })),
    acceptanceGate: v.acceptanceGate
      ? {
        active: v.acceptanceGate.active,
        commands: v.acceptanceGate.commands.map(entry => ({ ...entry })),
      }
      : undefined,
    rebuildEscalationInjections: v.rebuildEscalationInjections,
    parallelBudgetBlockHintInjected: v.parallelBudgetBlockHintInjected,
    v2UpdatedAt: v.v2UpdatedAt,
  };
}

function durableResilienceState(
  state: RuntimeCheckpointV2,
): Record<string, unknown> {
  const {
    verificationPending: _verificationPending,
    acceptanceGate: _acceptanceGate,
    ...durable
  } = cloneV2(state);
  return JSON.parse(JSON.stringify(durable)) as Record<string, unknown>;
}

function pathSessionId(checkpointPath: string): string {
  const name = checkpointPath.replace(/\\/g, '/').split('/').at(-1) ?? 'default.checkpoint.json';
  return name.endsWith('.checkpoint.json')
    ? name.slice(0, -'.checkpoint.json'.length)
    : 'default';
}

function cloneExecutionModeState(
  state: Partial<RuntimeExecutionModeCheckpointState>,
): RuntimeExecutionModeCheckpointState {
  const defaults = emptyRuntimeExecutionModeCheckpointState();
  return {
    executionMode: state.executionMode ?? defaults.executionMode,
    executionModeLockRemaining: state.executionModeLockRemaining ?? defaults.executionModeLockRemaining,
    executionModeEnteredBy: [...(state.executionModeEnteredBy ?? defaults.executionModeEnteredBy)],
    executionModeEnteredByPrimary: state.executionModeEnteredByPrimary,
    executionModeEnteredAtRound: state.executionModeEnteredAtRound ?? defaults.executionModeEnteredAtRound,
    forcedDegradedTier: state.forcedDegradedTier,
    lastModeDecision: state.lastModeDecision ? { ...state.lastModeDecision } : undefined,
    pendingModeSignals: [...(state.pendingModeSignals ?? defaults.pendingModeSignals)],
    forcedTaskBearingRoundsSinceEntry: state.forcedTaskBearingRoundsSinceEntry
      ?? defaults.forcedTaskBearingRoundsSinceEntry,
  };
}
