/**
 * Runtime Resilience v2 — 增强 checkpoint schema。
 *
 * 设计目标：
 *   1. 与 v1 (TaskCheckpoint) 完全兼容：v2 是 v1 的**可选**扩展，
 *      老 checkpoint 文件按 v1 解析即可，不丢任何字段。
 *   2. 仅在 `ICE_ENABLE_RESILIENCE_V2=1` 启用时被写入；
 *      关闭 flag 时 checkpoint 行为与现有 TaskCheckpointManager 完全一致。
 *   3. 字段全部是「快照型」描述，便于跨进程恢复执行控制状态。
 *
 * 设计文档：docs/长时间连续工作.md
 */

import type { StopReason } from '../harness/types.js';

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
  /** v2 写入时间 */
  v2UpdatedAt: string;
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
    v2UpdatedAt: new Date(0).toISOString(),
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
