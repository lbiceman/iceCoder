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
 *   3. **Feature flag 受控**：`ICE_ENABLE_RESILIENCE_V2=1` 关闭时
 *      该引擎不被实例化，行为完全等价于 v1。
 *
 * 持久化 trigger（来自 docs/长时间连续工作.md §Save Trigger）：
 *   - step completed / tool failed / verification started / verification failed
 *   - compaction / final draft
 *
 * 设计文档：docs/长时间连续工作.md §Part 3
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { TaskCheckpoint } from './checkpoint.js';
import type { ExecutionPlan } from '../types/execution-plan.js';
import {
  RUNTIME_CHECKPOINT_VERSION,
  isRuntimeCheckpointV2,
  emptyRuntimeCheckpointV2,
  type RuntimeCheckpointV2,
  type CheckpointSaveTrigger,
  type ToolHistoryEntry,
  type FailureHistoryEntry,
  type RecoverySignal,
} from '../types/runtime-checkpoint.js';
import { BranchBudgetTracker } from './branch-budget.js';

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
  /** 分支预算 tracker；engine 调用 .snapshot() 持久化 */
  branchBudget?: BranchBudgetTracker;
  /** 增量的 recent tool 记录（engine 内部自动累加 / 截断） */
  appendTool?: ToolHistoryEntry;
  /** 增量的 recent failure 记录 */
  appendFailure?: FailureHistoryEntry;
  /** 当前是否有 verification pending（来自 TaskState.shouldBlockFinalForVerification） */
  verificationPending?: boolean;
  /** 待注入的 recovery signal（新触发的） */
  appendRecoverySignal?: RecoverySignal;
  /** ExecutionPlan，可选（仅用于读 plan.version） */
  plan?: ExecutionPlan;
  /** Harness loop 当前 stopReason（如果已停止） */
  lastStopReason?: TaskCheckpoint['stopReason'];
}

/** 最大保留条目 */
const MAX_RECENT_TOOLS = 20;
const MAX_RECENT_FAILURES = 10;
const MAX_RECOVERY_SIGNALS = 8;

/** Feature flag 检测（独立函数便于测试 mock） */
export function isResilienceV2Enabled(): boolean {
  const raw = process.env.ICE_ENABLE_RESILIENCE_V2;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
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

  constructor(sessionDir: string, sessionId = 'default') {
    this.checkpointPath = path.join(sessionDir, `${sessionId}.checkpoint.json`);
  }

  /** 暴露内存中的 v2 状态（测试 / 调试用） */
  getV2State(): RuntimeCheckpointV2 {
    return cloneV2(this.v2State);
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

  /**
   * 合并保存：把 v2 附加字段写回到现有 checkpoint 文件。
   *
   * **不会清空** TaskCheckpointManager.save() 写入的 v1 字段；
   * 如果文件还不存在（v1 尚未写过），自动建立一个最小占位（只含 runtimeV2）。
   */
  async save(input: CheckpointSaveInput): Promise<RuntimeCheckpointV2> {
    this.applyInput(input);

    const existing = await this.readExistingFile();
    const merged: CombinedCheckpointFile = {
      ...(existing ?? this.buildMinimalV1Stub()),
      runtimeV2: cloneV2(this.v2State),
    };

    await fs.mkdir(path.dirname(this.checkpointPath), { recursive: true });
    const tmpPath = `${this.checkpointPath}.tmp`;
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

  private async readExistingFile(): Promise<CombinedCheckpointFile | null> {
    try {
      const raw = await fs.readFile(this.checkpointPath, 'utf-8');
      return JSON.parse(raw) as CombinedCheckpointFile;
    } catch {
      return null;
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
    },
    recentTools: v.recentTools.map(t => ({ ...t })),
    recentFailures: v.recentFailures.map(f => ({ ...f })),
    planVersion: v.planVersion,
    verificationPending: v.verificationPending,
    recoverySignals: v.recoverySignals.map(s => ({ ...s })),
    lastTrigger: v.lastTrigger,
    lastStopReason: v.lastStopReason,
    v2UpdatedAt: v.v2UpdatedAt,
  };
}
