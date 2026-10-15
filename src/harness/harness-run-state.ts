import type { UnifiedMessage, ToolDefinition } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import type { RepoContext } from './repo-context.js';
import type { StepReviewResult } from './step-review.js';
import type { TaskState } from './task-state.js';
import type { VerificationOutputBuffer } from './verification-output-buffer.js';
import type { CheckFailureStreakState } from './check-failure-streak.js';
import type { HarnessPolicyStats } from './harness-policy-stats.js';
import type { OperationOutcomeLedger } from './operation-outcome.js';
import type { CompletionCondition } from './completion-condition.js';
import type {
  CompletionReason,
  CompletionStatus,
} from './completion-state.js';
import type { VerificationPlanResolution } from './verification-plan.js';
import type { VerificationRuntimeState } from './verification-state.js';
import type {
  ExecutionMode,
  ForcedDegradedTier,
  ModeDecision,
  ModeSignal,
  ModeSignalSource,
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
  /** 连续工具失败轮次计数（一轮中所有工具都失败才算 1 次） */
  consecutiveToolFailures: number;
  /** 连续只读轮次计数（无 write/edit 工具调用的轮次） */
  consecutiveReadOnlyRounds: number;
  /** 本 run 是否已经跑过至少一轮可执行工具；下一轮 prep 据此改走标准召回 */
  hadToolRoundThisRun?: boolean;
  /** 正文里嵌入工具语法（未走 native function-calling）时的协议恢复次数 */
  noToolExecutionRecoveryCount: number;
  /** 本 run 是否已给过「文件交付未产出」的一次性完成自检 */
  completionSelfCheckIssued?: boolean;
  /** 本 run 开始时间；早于它的失败 / 拒绝来自旧 checkpoint，不作为收尾硬状态 */
  runStartedAt?: number;
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
  /** 上次已注入且模型见过的 runtime 正文；相同则本轮跳过 */
  runtimeStateHash: string;
  /** 锁定的工作区根目录（延迟锁定；unset 时不设） */
  lockedWorkspaceRoot?: string;
  /** 允许只读访问的参考文件路径（不在 workspace 内） */
  referenceReads?: string[];
  /** 上次已注入的 Workspace Anchor 正文；相同则本轮跳过 */
  workspaceAnchorHash?: string;
  /** 连续失败的工具调用签名计数 */
  failedToolCallSignatures: Map<string, number>;
  /** 分支预算 tracker；每次 run 都会创建 */
  branchBudget: BranchBudgetTracker;
  /** Resilience v2：本轮是否已注入过 branch-budget warning（避免重复） */
  branchBudgetWarnedThisRound: boolean;
  /** Resilience v2：本轮是否已注入验证失败 digest（避免重复） */
  verificationDigestInjectedThisRound: boolean;
  /** 文件 cap / 续段 / 检查失败 streak 等 Rebuild Escalation 注入次数（每 run 上限见 MAX_REBUILD_ESCALATIONS_PER_RUN） */
  rebuildEscalationInjections: number;
  /** 本轮是否已注入 Rebuild Escalation（同轮 file-cap / streak / 连续失败去重） */
  rebuildEscalationInjectedThisRound: boolean;
  /**
   * 同一规范化检查命令的连续失败次数。
   * write 不清零；该键终态成功才清零。新用户消息在 run() 清零。
   */
  checkFailureStreak?: CheckFailureStreakState;
  /** 本 run 是否已注入并行 BranchBudget 拦截指引（每 run 一次） */
  parallelBudgetBlockHintInjected: boolean;
  /** 会话级 immutable 任务目标（checkpoint userGoal 优先来源） */
  sessionGoalAnchor?: string;
  /** build 反复失败后进入诊断模式，暂停 build 类 run_command */
  buildDiagnosticGateActive?: boolean;
  /** 最近验收命令失败输出（compaction / policy block 后仍可注入 digest） */
  verificationOutputBuffer: VerificationOutputBuffer;
  /** 与语言/工具无关的操作结果账本，供统一收尾门控使用。 */
  operationOutcomes?: OperationOutcomeLedger;
  /** 当前目标与工作区解析出的确定性停时验收计划。 */
  verificationPlanResolution: VerificationPlanResolution;
  /** 验收 freshness、续轮预算和逐命令证据。 */
  verificationState: VerificationRuntimeState;
  /** 从 V3 恢复且尚未被本轮 tracker 替代的 completion 条件。 */
  restoredCompletionConditions?: CompletionCondition[];
  /** 上一次阻塞快照；相同快照不得重复注入。 */
  completionGateBlockingSignature?: string;
  /** 最近一次统一收尾裁决，供 checkpoint 原样恢复。 */
  completionStatus?: CompletionStatus;
  completionReason?: CompletionReason;
  /** missing-file preflight：同路径拦截次数 */
  missingFileAttempts: Map<string, number>;
  /** 本 run 内已被用户拒绝的 Shell mandatory-confirm 键。 */
  shellMandatoryConfirmDenials: Set<string>;
  /** Harness 策略拦截 / 恢复统计（telemetry summary） */
  harnessPolicyStats: HarnessPolicyStats;
  /** 续跑 Pre-flight 已做 checkpoint fork（首轮跳过常规压缩/记忆扩展） */
  checkpointResumeForkApplied: boolean;
  /** context window 超限后的 emergency/proactive fork 已用次数（每 run 最多 3 次） */
  contextEmergencyCompactCount?: number;
  /** 配额用尽时为 true（旧 checkpoint 仅有此字段时视为已用尽） */
  contextEmergencyCompactUsed: boolean;
  /** 续跑 checkpoint 短摘要（emergency fork 复用） */
  activeCheckpointResumeSummary?: UnifiedMessage;
  /** Resilience v2：本轮是否已做过 step review（避免重复） */
  stepReviewedThisRound: boolean;
  /** Resilience v2：最近一次 step review 结果（供启发式参考） */
  lastStepReview?: StepReviewResult;
  /** 执行边界模式。 */
  executionMode: ExecutionMode;
  /** forced 进入后的防抖锁剩余轮数。 */
  executionModeLockRemaining: number;
  /** 进入 forced 的有序信号列表。 */
  executionModeEnteredBy: ModeSignal[];
  /** 进入 forced 的主信号。 */
  executionModeEnteredByPrimary?: ModeSignal;
  /** 进入 forced 的轮次。 */
  executionModeEnteredAtRound?: number;
  /** forced 下当前退化层。 */
  forcedDegradedTier?: ForcedDegradedTier;
  /** 最近一次模式决策。 */
  lastModeDecision?: ModeDecision;
  /** 本轮待评估的 mode signals。 */
  pendingModeSignals: ModeSignal[];
  /** forced 期间的 task-bearing 轮次计数。 */
  forcedTaskBearingRoundsSinceEntry: number;
  /** 统一信号提交入口；子模块不得直接写 executionMode。 */
  submitModeSignal?: (
    source: ModeSignalSource,
    signal: ModeSignal,
    payload?: Record<string, unknown>,
  ) => void;
  /** 尚未被有效进展解除的 recovery 标志。只阻塞退出 forced，不参与进入。 */
  recoveryPendingSticky: boolean;
  /** 最近工具轮是否出现应升级模式的真实失败；验收命令失败不计入。 */
  lastRoundModeEscalatingFailure: boolean;
  /** 连续无失败轮次（与 consecutiveToolFailures 互斥推进），用于 stableRounds。 */
  stableRoundsSinceLastFailure: number;
  /** 本轮开始时 RepoContext.filesChanged 的长度，用于派生 accumulatedDiffLines。 */
  filesChangedAtRoundStart: number;
  /** 本轮是否发生任务图 fallback。由 submitModeSignal('branch_switched') 置位。 */
  branchSwitchedThisRound: boolean;
}
