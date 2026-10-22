import type { UnifiedMessage, ToolDefinition } from '../llm/types.js';
import type { RepoContext } from './repo-context.js';
import type { TaskState } from './task-state.js';
import type { VerificationOutputBuffer } from './verification-output-buffer.js';
import type { HarnessPolicyStats } from './harness-policy-stats.js';
import type { OperationOutcomeLedger } from './operation-outcome.js';
import type { CompletionCondition } from './completion-condition.js';
import type {
  CompletionReason,
  CompletionStatus,
} from './completion-state.js';
import type { VerificationPlanResolution } from './verification-plan.js';
import type { VerificationRuntimeState } from './verification-state.js';

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
  /** 会话级 immutable 任务目标（checkpoint userGoal 优先来源） */
  sessionGoalAnchor?: string;
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
  /** 硬压缩已回到微压缩线以下；等下一次模型真正响应后才返还 1 次配额 */
  emergencyCompactRefundPending?: boolean;
  /** 调用模型前因主动收缩而重试、尚未真正发出请求的连续次数 */
  compactionRetriesWithoutLlm?: number;
  /** 上一次发送前总量检查的本地估算；与 provider 实际 prompt token 对比得到校准系数 */
  lastSentEstimatedTokens?: number;
  /** 续跑 checkpoint 短摘要（emergency fork 复用） */
  activeCheckpointResumeSummary?: UnifiedMessage;
}
