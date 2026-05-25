import type { UnifiedMessage, ToolDefinition } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import type { RepoContext } from './repo-context.js';
import type { StepReviewResult } from './step-review.js';
import type { SupervisorRuntimeBridge } from './supervisor/supervisor-bridge.js';
import type { TaskState } from './task-state.js';
import type {
  ExecutionMode,
  ForcedDegradedTier,
  ModeDecision,
  ModeSignal,
  ModeSignalSource,
  SupervisorPhase,
} from '../types/supervisor.js';

/**
 * 循环 continue 的原因（用于调试和测试）。
 */
export type Transition =
  | 'initial'
  | 'tool_calls'
  | 'no_tool_execution_recovery'
  | 'max_output_tokens_recovery'
  | 'stop_hook_continue'
  | 'llm_error_retry'
  | 'compaction_retry';

/**
 * 迭代间携带的可变状态。
 */
export interface HarnessRunState {
  /** 当前对话消息列表 */
  messages: UnifiedMessage[];
  /** 可用工具定义 */
  tools: ToolDefinition[];
  /** 当前轮次 */
  turnCount: number;
  /** max-output-tokens 恢复计数 */
  maxOutputTokensRecoveryCount: number;
  /** LLM 调用连续重试计数 */
  llmRetryCount: number;
  /** LLM 空响应重试计数 */
  emptyResponseRetryCount: number;
  /** 仅 reasoning 无 toolCalls 时的恢复次数 */
  reasoningOnlyRecoveryCount: number;
  /** 验收未清时拦截 model_done 的次数 */
  prematureCompletionRecoveryCount: number;
  /** 连续工具失败轮次计数（一轮中所有工具都失败才算 1 次） */
  consecutiveToolFailures: number;
  /** 连续只读轮次计数（无 write/edit 工具调用的轮次） */
  consecutiveReadOnlyRounds: number;
  /** 执行型任务但模型未调用工具时的自动恢复次数 */
  noToolExecutionRecoveryCount: number;
  /** 本轮是否已注入任务切换提示（防止重复注入） */
  taskSwitchInjected: boolean;
  /** stop_hook 连续干预计数 */
  stopHookContinuationCount: number;
  /** 上一次 continue 的原因 */
  transition: Transition;
  /** 本轮是否刚刚完成上下文压缩 */
  justCompacted: boolean;
  /** 压缩后失忆恢复次数（每次压缩后最多 1 次） */
  amnesiaRecoveryCount: number;
  /** 当前任务状态账本 */
  taskState: TaskState;
  /** 当前仓库上下文账本 */
  repoContext: RepoContext;
  /** 上次注入 runtime state 的内容 hash */
  runtimeStateHash: string;
  /** 连续失败的工具调用签名计数 */
  failedToolCallSignatures: Map<string, number>;
  /** Resilience v2：分支预算 tracker */
  branchBudget?: BranchBudgetTracker;
  /** Resilience v2：本轮是否已注入过 branch-budget warning（避免重复） */
  branchBudgetWarnedThisRound: boolean;
  /** Resilience v2：本轮是否已注入验证失败 digest（避免重复） */
  verificationDigestInjectedThisRound: boolean;
  /** Resilience v2：本轮是否已做过 step review（避免重复） */
  stepReviewedThisRound: boolean;
  /** Resilience v2：最近一次 step review 结果（供启发式参考） */
  lastStepReview?: StepReviewResult;
  /** Batch 1 承载位：执行边界模式；默认由现有逻辑保持未设置。 */
  executionMode?: ExecutionMode;
  /** Batch 1 承载位：forced 进入后的防抖锁。 */
  executionModeLockRemaining?: number;
  /** Batch 1 承载位：进入 forced 的有序信号列表。 */
  executionModeEnteredBy?: ModeSignal[];
  /** Batch 1 承载位：进入 forced 的主信号。 */
  executionModeEnteredByPrimary?: ModeSignal;
  /** Batch 1 承载位：进入 forced 的 round。 */
  executionModeEnteredAtRound?: number;
  /** Batch 1 承载位：forced 下当前退化层。 */
  forcedDegradedTier?: ForcedDegradedTier;
  /** Batch 1 承载位：最近一次模式决策。 */
  lastModeDecision?: ModeDecision;
  /** Batch 1 承载位：本轮待评估 mode signals。 */
  pendingModeSignals?: ModeSignal[];
  /** Batch 1 承载位：I10 task-bearing round 计数。 */
  forcedTaskBearingRoundsSinceEntry?: number;
  /** Batch 1 承载位：Supervisor 运行时相位；run() 入口必填，子模块直接读取无需兜底。 */
  supervisorPhase: SupervisorPhase;
  /** Batch 4：统一信号提交入口；子模块不得直接写 executionMode。 */
  submitModeSignal?: (
    source: ModeSignalSource,
    signal: ModeSignal,
    payload?: Record<string, unknown>,
  ) => void;
  /** W4：recovery 信号的「跨轮 sticky」标志；由 supervisor 接管完成时清除。仅阻塞 exit，不参与 enter。 */
  recoveryPendingSticky?: boolean;
  /** W1：连续无失败轮次计数（与 consecutiveToolFailures 互斥推进），用于 stableRounds 派生。 */
  stableRoundsSinceLastFailure?: number;
  /** W1：本轮开始时 RepoContext.filesChanged 长度的快照，用于派生 accumulatedDiffLines。 */
  filesChangedAtRoundStart?: number;
  /** W1：本轮是否发生分支切换（task graph fallback）。由 submitModeSignal('branch_switched') 同步置位。 */
  branchSwitchedThisRound?: boolean;
  /**
   * L2-6 — Harness 主循环持有的 SupervisorRuntimeBridge 引用（off 时缺省）。
   * `harness-resilience.buildSupervisorCheckpointState` 与 after-round 钩子读取本字段，
   * 避免把 bridge 经各子模块依赖链层层传递。
   */
  supervisorBridge?: SupervisorRuntimeBridge;
}
