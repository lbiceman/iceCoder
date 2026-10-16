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

import type { TaskCheckpoint } from './checkpoint.js';
import {
  RUNTIME_CHECKPOINT_VERSION,
  isRuntimeCheckpointV2,
  emptyRuntimeCheckpointV2,
  isProjectCheckpointV3,
  cloneProjectCheckpointV3,
  type RuntimeCheckpointV2,
  type CheckpointSaveTrigger,
  type ToolHistoryEntry,
  type FailureHistoryEntry,
  type VerificationOutputTailEntry,
  type ProjectCheckpointV3,
} from '../types/runtime-checkpoint.js';
import { ProjectCheckpointStore } from './project-checkpoint-store.js';
import { adaptLegacyCheckpoint } from './legacy-checkpoint-adapter.js';

/** 增强 checkpoint 在磁盘上的存储壳子 —— 与 TaskCheckpoint(v1) 共享同一个 JSON。 */
export interface CombinedCheckpointFile extends TaskCheckpoint {
  /** v2 附加字段（v1 进程读到时会忽略，不影响兼容） */
  runtimeV2?: RuntimeCheckpointV2;
}

/** Save 时调用方传入的「最新运行时状态」 */
export interface CheckpointSaveInput {
  trigger: CheckpointSaveTrigger;
  /** 当前执行步骤信息（来自 ExecutionPlanTracker.getPlan().activeStepId） */
  currentStepId?: string;
  currentStepTitle?: string;
  /** 增量的 recent tool 记录（engine 内部自动累加 / 截断） */
  appendTool?: ToolHistoryEntry;
  /** 增量的 recent failure 记录 */
  appendFailure?: FailureHistoryEntry;
  /** ExecutionPlan，可选（仅用于读 plan.version） */
  plan?: any;
  /** Harness loop 当前 stopReason（如果已停止） */
  lastStopReason?: TaskCheckpoint['stopReason'];
  /** 最近验收失败 stderr tail（VerificationOutputBuffer.snapshot） */
  verificationOutputTail?: VerificationOutputTailEntry[];
}

/** 最大保留条目 */
const MAX_RECENT_TOOLS = 20;
const MAX_RECENT_FAILURES = 10;

/**
 * 单独落盘的触发器。step_completed / verification_started 不单独写，
 * 由每轮收尾的 saveTaskCheckpoint 一次落盘，避免「轻读取」任务频繁写盘。
 */
const PERSIST_TRIGGERS: ReadonlySet<CheckpointSaveTrigger> = new Set([
  'tool_failed',
  'verification_failed',
  'compaction',
  'final_draft',
]);

/**
 * 增强 checkpoint 引擎。
 *
 * 用法：
 *   const engine = new CheckpointEngine(sessionDir, sessionId);
 *   await engine.save({ trigger: 'tool_failed', appendFailure, ... });
 *   const restored = await engine.loadV2();   // null 则回退到 v1
 */
export class CheckpointEngine {
  readonly checkpointPath: string;
  private readonly projectStore: ProjectCheckpointStore;
  /** 内存中保留的 v2 累积状态（save 之间增量更新） */
  private v2State: RuntimeCheckpointV2 = emptyRuntimeCheckpointV2();
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
   * 给定保存触发器，返回是否应单独落盘：仅 tool_failed / verification_failed / compaction / final_draft。
   * 调用方仍可以无条件 save()——本方法用于上层 gating，避免不必要的磁盘开销。
   */
  shouldPersistOnTrigger(trigger: CheckpointSaveTrigger): boolean {
    return PERSIST_TRIGGERS.has(trigger);
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
    } catch (err) {
      console.warn('[checkpoint-engine] loadV2 failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  /**
   * 把已经 stage 过的 v2 状态叠进一份即将落盘的 aggregate，不再单独写文件。
   */
  overlayOnto(project: ProjectCheckpointV3, input: CheckpointSaveInput): ProjectCheckpointV3 {
    return this.materializeAggregate(project, input);
  }

  /**
   * 合并保存：把 v2 附加字段写回到现有 checkpoint 文件。
   *
   * **不会清空** TaskCheckpointManager.save() 写入的 v1 字段；
   * 如果文件还不存在（v1 尚未写过），自动建立一个最小占位（只含 runtimeV2）。
   * 与 TaskCheckpoint 同轮收尾时优先走 overlayOnto，避免双写。
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
    await this.projectStore.save(this.materializeAggregate(aggregate, input));

    return cloneV2(this.v2State);
  }

  private materializeAggregate(
    aggregate: ProjectCheckpointV3,
    input: CheckpointSaveInput,
  ): ProjectCheckpointV3 {
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
    next.extensions.runtimeResilience = durableResilienceState(this.v2State);
    return next;
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
    if (input.verificationOutputTail !== undefined) {
      state.verificationOutputTail = input.verificationOutputTail.map(entry => ({ ...entry }));
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
        workspaceMutationVersion: 0,
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
  if (!Array.isArray(record.recentTools) || !Array.isArray(record.recentFailures)) {
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

function cloneV2(v: RuntimeCheckpointV2): RuntimeCheckpointV2 {
  return {
    runtimeVersion: RUNTIME_CHECKPOINT_VERSION,
    currentStepId: v.currentStepId,
    currentStepTitle: v.currentStepTitle,
    recentTools: v.recentTools.map(t => ({ ...t })),
    recentFailures: v.recentFailures.map(f => ({ ...f })),
    planVersion: v.planVersion,
    verificationPending: v.verificationPending,
    lastTrigger: v.lastTrigger,
    lastStopReason: v.lastStopReason,
    verificationOutputTail: v.verificationOutputTail?.map(entry => ({ ...entry })),
    acceptanceGate: v.acceptanceGate
      ? {
        active: v.acceptanceGate.active,
        commands: v.acceptanceGate.commands.map(entry => ({ ...entry })),
      }
      : undefined,
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
