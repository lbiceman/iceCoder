import type { UnifiedMessage, ToolDefinition } from '../llm/types.js';
import type { BranchBudgetTracker } from './branch-budget.js';
import type { RepoContext } from './repo-context.js';
import type { StepReviewResult } from './step-review.js';
import type { SupervisorRuntimeBridge } from './supervisor/supervisor-bridge.js';
import type { TaskState } from './task-state.js';
import type { VerificationOutputBuffer } from './verification-output-buffer.js';
import type { TaskAcceptanceTracker } from './task-acceptance-tracker.js';
import type { HarnessPolicyStats } from './harness-policy-stats.js';
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
  /** 锁定的工作区根目录（延迟锁定；unset 时不设） */
  lockedWorkspaceRoot?: string;
  /** 允许只读访问的参考文件路径（不在 workspace 内） */
  referenceReads?: string[];
  /** 上次注入 Workspace Anchor 的内容 hash */
  workspaceAnchorHash?: string;
  /** 连续失败的工具调用签名计数 */
  failedToolCallSignatures: Map<string, number>;
  /** Resilience v2：分支预算 tracker */
  branchBudget?: BranchBudgetTracker;
  /** Resilience v2：本轮是否已注入过 branch-budget warning（避免重复） */
  branchBudgetWarnedThisRound: boolean;
  /** Resilience v2：本轮是否已注入验证失败 digest（避免重复） */
  verificationDigestInjectedThisRound: boolean;
  /** 连续失败达 REBUILD_ESCALATION_THRESHOLD 后注入整文件重建提示的次数（每 run 上限见 harness-constants）。 */
  rebuildEscalationInjections: number;
  /** 本轮是否已注入 Rebuild Escalation（同轮 file-cap / 连续失败去重） */
  rebuildEscalationInjectedThisRound: boolean;
  /** 本 run 是否已注入并行 BranchBudget 拦截指引（每 run 一次） */
  parallelBudgetBlockHintInjected: boolean;
  /** Segment Renewal：本 run 内已续段次数（与 supervisor bridge 同步） */
  segmentRenewalCount: number;
  /** 会话级 immutable 任务目标（checkpoint userGoal 优先来源） */
  sessionGoalAnchor?: string;
  /** build 反复失败后进入诊断模式，暂停 build 类 run_command */
  buildDiagnosticGateActive?: boolean;
  /** 最近验收命令失败输出（compaction / policy block 后仍可注入 digest） */
  verificationOutputBuffer: VerificationOutputBuffer;
  /** 长跑任务多命令验收门禁（npm ci → test → build → e2e） */
  taskAcceptance?: TaskAcceptanceTracker;
  /** 连续无工具调用的 LLM 轮（用于 no_progress / 早停拦截） */
  consecutiveNoToolRounds: number;
  /** missing-file preflight：同路径拦截次数 */
  missingFileAttempts: Map<string, number>;
  /** Harness 策略拦截 / 恢复统计（telemetry summary） */
  harnessPolicyStats: HarnessPolicyStats;
  /** 续跑 Pre-flight 已做 checkpoint fork（首轮跳过常规压缩/记忆扩展） */
  checkpointResumeForkApplied: boolean;
  /** context window 超限后的 emergency compact 是否已用过（每 run 一次） */
  contextEmergencyCompactUsed: boolean;
  /** 续跑 checkpoint 短摘要（emergency fork 复用） */
  activeCheckpointResumeSummary?: UnifiedMessage;
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
