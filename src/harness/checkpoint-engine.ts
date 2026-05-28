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

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { TaskGraphSnapshot, GraphMetrics, GraphSession } from '../types/task-graph.js';
import type { TaskCheckpoint } from './checkpoint.js';
// ExecutionPlan type removed (Phase 11)
import {
  RUNTIME_CHECKPOINT_VERSION,
  isRuntimeCheckpointV2,
  emptyRuntimeCheckpointV2,
  emptyRuntimeSupervisorCheckpointState,
  type RuntimeCheckpointV2,
  type RuntimeSupervisorCheckpointState,
  type CheckpointSaveTrigger,
  type ToolHistoryEntry,
  type FailureHistoryEntry,
  type RecoverySignal,
  type VerificationOutputTailEntry,
  type AcceptanceGateSnapshot,
} from '../types/runtime-checkpoint.js';
import { BranchBudgetTracker } from './branch-budget.js';
import type { AcceptanceCommandEntry } from './task-acceptance-tracker.js';

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
  /** 当前是否有 verification pending（来自 TaskState.isVerificationBlockingFinalAfterSync） */
  verificationPending?: boolean;
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
  /** Supervisor execution-mode snapshot; restore path may only convert it into signals. */
  supervisorState?: RuntimeSupervisorCheckpointState;
  /** 最近验收失败 stderr tail（VerificationOutputBuffer.snapshot） */
  verificationOutputTail?: VerificationOutputTailEntry[];
  /** TaskAcceptanceTracker.snapshot */
  acceptanceGate?: AcceptanceGateSnapshot;
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
  /** 内存中保留的 v2 累积状态（save 之间增量更新） */
  private v2State: RuntimeCheckpointV2 = emptyRuntimeCheckpointV2();
  /** §2.8 / T12 — forced 段是否启用更积极的 checkpoint policy。 */
  private forcedPolicyActive = false;

  constructor(sessionDir: string, sessionId = 'default') {
    this.checkpointPath = path.join(sessionDir, `${sessionId}.checkpoint.json`);
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
      const raw = await fs.readFile(this.checkpointPath, 'utf-8');
      const parsed = JSON.parse(raw) as CombinedCheckpointFile;
      if (parsed && isRuntimeCheckpointV2(parsed.runtimeV2)) {
        this.v2State = cloneV2(parsed.runtimeV2);
        return cloneV2(parsed.runtimeV2);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 加载完整 CombinedCheckpointFile（含 taskGraph 等 Phase 6 字段） */
  async loadCombined(): Promise<CombinedCheckpointFile | null> {
    try {
      const raw = await fs.readFile(this.checkpointPath, 'utf-8');
      const parsed = JSON.parse(raw) as CombinedCheckpointFile;
      return parsed ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 合并保存：把 v2 附加字段写回到现有 checkpoint 文件。
   *
   * **不会清空** TaskCheckpointManager.save() 写入的 v1 字段；
   * 如果文件还不存在（v1 尚未写过），自动建立一个最小占位（只含 runtimeV2）。
   */
  async save(input: CheckpointSaveInput): Promise<RuntimeCheckpointV2> {
    this.applyInput(input);

    await fs.mkdir(path.dirname(this.checkpointPath), { recursive: true });
    const tmpPath = `${this.checkpointPath}.${randomUUID()}.tmp`;

    const isTerminal = (c: CombinedCheckpointFile | null | undefined): c is CombinedCheckpointFile =>
      !!c && (c.status === 'completed' || c.status === 'failed' || c.status === 'aborted');

    const peekA = await this.readExistingCheckpoint(6, 14);
    const peekB = await this.readExistingCheckpoint(6, 14);

    let base: CombinedCheckpointFile | null =
      isTerminal(peekB) ? peekB
      : isTerminal(peekA) ? peekA
      : peekB ?? peekA;

    // TaskCheckpointManager 写完 tmp 后 rename 的极短窗口内读盘可能失败；
    // 若目标文件已存在，则短重试而非用 running stub 覆盖可能已写入的终态 v1。
    if (!base) {
      try {
        await fs.access(this.checkpointPath);
        for (let i = 0; i < 12; i++) {
          const recovered = await this.readExistingCheckpoint(4, 20);
          if (recovered) {
            base = recovered;
            break;
          }
          await new Promise((r) => setTimeout(r, 12));
        }
        if (!base) {
          console.debug(
            '[checkpoint-engine] skip v2 merge write: checkpoint file exists but JSON not readable yet',
          );
          return cloneV2(this.v2State);
        }
      } catch {
        base = this.buildMinimalV1Stub();
      }
    }

    let merged: CombinedCheckpointFile = {
      ...base,
      runtimeV2: cloneV2(this.v2State),
      taskGraph: input.taskGraphSnapshot,
      graphMetrics: input.graphMetrics,
      graphSession: input.graphSession,
    };

    const peekC = await this.readExistingCheckpoint(8, 18);
    if (isTerminal(peekC)) {
      merged = { ...peekC, runtimeV2: cloneV2(this.v2State), taskGraph: input.taskGraphSnapshot, graphMetrics: input.graphMetrics, graphSession: input.graphSession };
    }

    // rename 前一拍：Manager 可能比 Engine 的快照更新；必须用最新磁盘快照做 v1 信封，否则会写回陈旧 running。
    const fence = await this.readExistingCheckpoint(12, 16);
    if (fence) {
      merged = { ...fence, runtimeV2: cloneV2(this.v2State), taskGraph: input.taskGraphSnapshot, graphMetrics: input.graphMetrics, graphSession: input.graphSession };
    } else if (await this.checkpointMainPathProbablyExists()) {
      console.debug(
        '[checkpoint-engine] skip v2 merge write before rename: file exists but could not parse JSON reliably',
      );
      return cloneV2(this.v2State);
    }

    await fs.writeFile(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
    await fs.rename(tmpPath, this.checkpointPath);

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
    if (input.verificationPending !== undefined) state.verificationPending = input.verificationPending;
    if (input.lastStopReason !== undefined) state.lastStopReason = input.lastStopReason;
    if (input.plan?.version !== undefined) state.planVersion = input.plan.version;
    if (input.supervisorState) {
      state.supervisorState = cloneSupervisorState(input.supervisorState);
    }
    if (input.verificationOutputTail !== undefined) {
      state.verificationOutputTail = input.verificationOutputTail.map(entry => ({ ...entry }));
    }
    if (input.acceptanceGate !== undefined) {
      state.acceptanceGate = {
        active: input.acceptanceGate.active,
        commands: input.acceptanceGate.commands.map((entry: AcceptanceCommandEntry) => ({ ...entry })),
      };
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

  /** 重置内存 v2 状态（任务切换时调用） */
  resetMemory(): void {
    this.v2State = emptyRuntimeCheckpointV2();
  }

  // ─── 内部 ───

  /** 是否为「尚无 checkpoint 文件」类错误；ENOENT 不重试 backoff，否则会拖慢首轮 save（单测超时）。 */
  private isENOENT(err: unknown): boolean {
    return typeof err === 'object'
      && err !== null
      && 'code' in err
      && (err as { code?: unknown }).code === 'ENOENT';
  }

  /** 校验 JSON checkpoint 的版本号是否为有效 v1。 */
  private isV1CombinedCheckpoint(parsed: unknown): parsed is CombinedCheckpointFile {
    if (!parsed || typeof parsed !== 'object') return false;
    const ver = (parsed as { version?: unknown }).version;
    return typeof ver === 'number' && ver === 1;
  }

  /** 读取现有 checkpoint JSON；多轮退让重试以降低与 TaskCheckpointManager.rename 的竞争读失败概率。 */
  private async readExistingCheckpoint(
    maxAttempts: number,
    baseBackoffMs = 22,
  ): Promise<CombinedCheckpointFile | null> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const raw = await fs.readFile(this.checkpointPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (!this.isV1CombinedCheckpoint(parsed)) continue;
        return parsed;
      } catch (err: unknown) {
        if (this.isENOENT(err)) return null;
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, baseBackoffMs * (attempt + 1)));
        }
      }
    }
    return null;
  }

  /** 磁盘上是否存在主 checkpoint 路径（先于 JSON 解析）；配合「存在但解析失败→跳过写入」语义。 */
  private async checkpointMainPathProbablyExists(): Promise<boolean> {
    try {
      await fs.access(this.checkpointPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 当 checkpoint 文件还不存在时生成一个最小 v1 兼容壳。
   * 真正的 v1 完整字段由 TaskCheckpointManager.save() 在下一次循环中覆盖。
   */
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
        verificationRequired: false,
        verificationStatus: 'not_required',
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
    supervisorState: v.supervisorState ? cloneSupervisorState(v.supervisorState) : undefined,
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

function cloneSupervisorState(
  state: Partial<RuntimeSupervisorCheckpointState>,
): RuntimeSupervisorCheckpointState {
  const defaults = emptyRuntimeSupervisorCheckpointState();
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
    // L2-6 / T08：Supervisor phase + snapshot + timeline tail + I4 budget。
    supervisorPhase: state.supervisorPhase ?? defaults.supervisorPhase,
    recoverySupervisorSnapshot: state.recoverySupervisorSnapshot
      ? { ...state.recoverySupervisorSnapshot }
      : undefined,
    timelineTail: state.timelineTail
      ? state.timelineTail.map(ev => ({
        ...ev,
        ...(ev.payload ? { payload: { ...ev.payload } } : {}),
      }))
      : undefined,
    correctionBudgetUsed: state.correctionBudgetUsed ?? defaults.correctionBudgetUsed,
  };
}
