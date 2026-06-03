/**
 * Harness 层类型定义。
 * Harness 是"软件 ←→ 模型"的机模交互层，
 * 负责上下文组装、工具权限、循环控制和可靠性。
 */

import type { UnifiedMessage, ToolDefinition, LLMResponse } from '../llm/types.js';
import type { HarnessLogEntry } from './logger.js';
import type { FileMemoryManager } from '../memory/file-memory/file-memory-manager.js';
import type { TaskGraphView, TaskGraphPatch } from '../types/task-graph-view.js';
import type {
  ExecutionMode,
  ExecutionModeTelemetryPayload,
  ForcedDegradedTier,
  GlobalModePolicy,
  ModeDecision,
  ModeSignal,
  ResolvedSupervisorConfig,
  SupervisorPhase,
} from '../types/supervisor.js';

// ─── 上下文组装 ───

/**
 * 上下文组装配置，决定"喂什么"给模型。
 */
export interface ContextAssemblyConfig {
  /** 系统提示词（静态部分，可缓存） */
  systemPrompt: string;
  /** 可用工具定义 */
  tools: ToolDefinition[];
  /** 可选：固定工作语言时注入动态层；留空则不由系统指定语种 */
  language?: string;
  /** 环境信息（OS、当前目录等） */
  environment?: Record<string, string>;
  /** 持久化记忆提示词（由 loadMemoryPrompt 生成，包含记忆指令 + MEMORY.md 内容） */
  memoryPrompt?: string;
  /** 额外记忆片段（向后兼容） */
  memories?: string[];
  /** 用户偏好 */
  userPreferences?: Record<string, any>;
  /** 用户上下文（CLAUDE.md 内容等，以 key-value 形式注入到 <system-reminder>） */
  userContext?: Record<string, string>;
  /** 系统上下文（Git 状态等实时信息，追加到系统提示词末尾） */
  systemContext?: Record<string, string>;
}

// ─── 权限系统 ───

/**
 * 工具权限级别。
 */
export type ToolPermission = 'allow' | 'confirm' | 'deny';

/**
 * 工具权限规则。
 */
export interface ToolPermissionRule {
  /** 工具名称或通配符模式 */
  pattern: string;
  /** 权限级别 */
  permission: ToolPermission;
  /** 规则描述 */
  reason?: string;
  message?: string;
}

/**
 * 权限检查结果。
 */
export interface PermissionCheckResult {
  allowed: boolean;
  permission: ToolPermission;
  rule?: ToolPermissionRule;
  message?: string;
}

// ─── 循环控制 ───

/**
 * 循环控制配置，决定"什么时候停"。
 */
export interface LoopControlConfig {
  /** 最大循环轮次 */
  maxRounds: number;
  /** Token 预算上限（输入+输出总计） */
  tokenBudget?: number;
  /** 单轮最大输出 token */
  maxOutputTokens?: number;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** AbortSignal 用于用户中断 */
  signal?: AbortSignal;
}

/**
 * 循环停止原因。
 */
export type StopReason =
  | 'model_done'         // 模型说 done
  | 'max_rounds'         // 达到最大轮次
  | 'token_budget'       // token 预算耗尽
  | 'task_recovery'      // 压缩后失忆恢复
  | 'timeout'            // 超时
  | 'user_abort'         // 用户中断
  | 'user_checkpoint'    // Supervisor 请求人工 checkpoint（Web 冰豆 crying + 固定 final 文案）
  | 'max_output_tokens'  // 输出 token 达到上限（finishReason === 'length'）
  | 'stop_hook'          // 停止钩子阻止继续（连续干预超限）
  | 'verification_exhausted' // verification gate 连续注入超限
  | 'circuit_breaker'    // 连续工具失败熔断
  | 'error';             // 错误

/** 推送到前端的记忆子状态（冰豆 / Web 会话指示气泡）；hit/coarse_hit 仅在已注入本轮模型上下文时发出 */
export type MemoryStepKind =
  | 'recall_coarse_hit'  // 首轮 LLM 前粗召回且已并入提示
  | 'recall_hit'         // 标准召回且已并入提示
  | 'recall_empty'       // 标准召回无结果
  | 'recall_skipped'     // 跳过（空库、过滤、去重后无条等）
  | 'session_hydrate';   // 从 session-notes 恢复运行时快照

/**
 * 循环状态跟踪。
 */
export interface LoopState {
  /** 当前轮次 */
  currentRound: number;
  /** 累计输入 token（所有轮次 API 返回的 inputTokens 之和） */
  totalInputTokens: number;
  /** 累计输出 token（所有轮次 API 返回的 outputTokens 之和） */
  totalOutputTokens: number;
  /** 最后一轮 API 调用的输入 token（= 当前上下文窗口占用） */
  lastInputTokens: number;
  /** 最后一轮 API 调用的输出 token */
  lastOutputTokens: number;
  /** 累计工具调用次数 */
  totalToolCalls: number;
  /** 开始时间 */
  startTime: number;
  /** 停止原因（循环结束后设置） */
  stopReason?: StopReason;
  /** TaskGraph (Phase 7) */
  graphGoal?: string;
  graphIntent?: string;
  graphStatus?: string;
  nodeId?: string;
  nodeIndex?: number;
  reason?: string;
  message?: string;
  /** Execution Free/Forced 执行边界；Batch 1 仅提供后续任务承载位，不改变运行逻辑。 */
  executionMode?: ExecutionMode;
  /** Forced enter 后的防抖锁剩余轮数。 */
  executionModeLockRemaining?: number;
  /** 上次进入 forced 的触发信号，按 §2.8.8 排序。 */
  executionModeEnteredBy?: ModeSignal[];
  /** 上次进入 forced 的主触发信号。 */
  executionModeEnteredByPrimary?: ModeSignal;
  /** 上次进入 forced 的 round。 */
  executionModeEnteredAtRound?: number;
  /** Forced 下当前退化层。 */
  forcedDegradedTier?: ForcedDegradedTier;
  /** 最近一次模式决策，供 telemetry/checkpoint 观察。 */
  lastModeDecision?: ModeDecision;
  /** 本轮待评估 ModeSignal；后续任务保持 append-only。 */
  pendingModeSignals?: ModeSignal[];
  /** I10：进入 forced 后已完成的 task-bearing round 数。 */
  forcedTaskBearingRoundsSinceEntry?: number;
  /** Supervisor 运行时相位承载位；由后续 RecoverySupervisor 任务使用。 */
  supervisorPhase?: SupervisorPhase;
}

// ─── Harness 核心 ───

/**
 * Harness 配置。
 */
export interface HarnessConfig {
  /** 上下文组装配置 */
  context: ContextAssemblyConfig;
  /** 循环控制配置 */
  loop: LoopControlConfig;
  /** 权限规则 */
  permissions?: ToolPermissionRule[];
  /** 为 true 时跳过 deny/confirm/破坏性确认等全部权限检查 */
  skipPermissionChecks?: boolean;
  /** 上下文压缩阈值（消息数量，向后兼容） */
  compactionThreshold?: number;
  /** 上下文压缩的 token 阈值（优先于消息数阈值，默认 80000） */
  compactionTokenThreshold?: number;
  /** 上下文压缩后保留的最近消息数 */
  compactionKeepRecent?: number;
  /** 是否启用 LLM 摘要压缩（默认 false，启用后压缩质量更高但消耗额外 token） */
  compactionEnableLLMSummary?: boolean;
  /** 硬压缩后再注入的 read_file 唯一路径数上限（传入则由 Harness 交给 ContextCompactor，默认 12） */
  compactionMaxReinjectFiles?: number;
  /** confirm 权限的回调：返回 true 允许，false 拒绝 */
  onConfirm?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  /** 记忆文件目录路径（用于文件记忆预取，向后兼容） */
  memoryDir?: string;
  /** 文件记忆管理器（优先于 memoryDir，提供多级加载+异步预取+自动提取） */
  fileMemoryManager?: FileMemoryManager;
  /** 会话目录，用于保存任务断点 checkpoint */
  sessionDir?: string;
  /** 工作区根目录（会话笔记 package.json 锚定；默认 process.cwd()） */
  workspaceRoot?: string;
  /**
   * 写后读 Gate 豁免目录（相对工作区）；与工作区 `.icecoder.json` 合并。
   * 未设置时仅使用全局 config 与工作区项目文件。
   */
  verificationExemptDirs?: string[];
  /** 会话 ID，用于多会话 checkpoint 文件名（默认 default） */
  sessionId?: string;
  /** Batch 1：可选注入的全局策略，只读承载位；本批不接入 Harness 主循环。 */
  globalPolicy?: GlobalModePolicy;
  /** Batch 1：可选 supervisor 配置依赖，只读承载位；本批不改变现有运行逻辑。 */
  supervisorConfig?: ResolvedSupervisorConfig;
  /** L2-1+：SupervisorRuntimeBridge；工具轮末段调用 PassiveObserver。 */
  supervisorBridge?: import('./supervisor/supervisor-bridge.js').SupervisorRuntimeBridge;
}

/**
 * Harness 循环中每一步的事件回调。
 *
 * `execution_plan_init` / `execution_plan_update` / `execution_plan_clear` 保留给前端兼容（Phase 13）；
 * 新事件 `task_graph_*` 由 TaskGraph 驱动。
 */
export type ToolOutcome = 'executed' | 'policy_block' | 'user_denied' | 'execution_fail';

/** step / WS 共用的 token 用量（圆环与压缩判定对齐） */
export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** max(本地 messages + tools 估算, 上一轮 API prompt_tokens) */
  effectiveUsed?: number;
  /** provider maxContextTokens（上下文窗口上限） */
  contextWindow?: number;
}

export interface HarnessStepEvent {
  type:
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'tool_denied'
    | 'tool_confirm'
    | 'tool_progress'
    | 'compaction'
    | 'context_usage'
    | 'final'
    | 'stream_delta'
    | 'tool_output'
    | 'memory_event'
    | 'execution_plan_init'
    | 'execution_plan_update'
    | 'execution_plan_clear'
    | 'task_graph_init'
    | 'task_graph_node'
    | 'task_graph_update'
    | 'task_graph_branch'
    | 'task_graph_done'
    | 'execution_mode_enter'
    | 'execution_mode_exit';
  iteration?: number;
  content?: string;
  /** 流式输出的增量文本（仅 stream_delta 类型） */
  delta?: string;
  /** 工具执行中给用户看的提示（仅 tool_progress） */
  phase?: 'running';
  toolName?: string;
  /** 与 assistant tool_calls.id 对应，供 UI 按调用挂载 diff */
  toolCallId?: string;
  toolArgs?: Record<string, any>;
  toolSuccess?: boolean;
  toolOutput?: string;
  toolError?: string;
  /** 工具结果语义：executed=真执行；policy_block=Harness 策略拦截；user_denied=用户拒绝；execution_fail=执行器失败 */
  toolOutcome?: ToolOutcome;
  totalToolCalls?: number;
  stopReason?: StopReason;
  /** TaskGraph (Phase 7) */
  graphGoal?: string;
  graphIntent?: string;
  graphStatus?: string;
  nodeId?: string;
  nodeIndex?: number;
  reason?: string;
  message?: string;
  /** 本轮 LLM 调用的 token 用量 */
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /** 累计 token 用量（含 effectiveUsed / contextWindow 供圆环对齐） */
  totalTokenUsage?: TokenUsageTotals;
  /** 记忆子状态（仅 type === 'memory_event'） */
  memoryKind?: MemoryStepKind;
  /** 给用户看的短说明（气泡） */
  memoryDetail?: string;
  /** TaskGraph 全量视图（execution_plan_init / task_graph_init） */
  plan?: TaskGraphView;
  /** 执行计划 ID（仅 type === 'execution_plan_update'） */
  planId?: string;
  /** TaskGraph 增量补丁（仅 type === 'execution_plan_update'） */
  patch?: TaskGraphPatch;
  /** Execution Mode telemetry payload（仅 execution_mode_enter / execution_mode_exit） */
  executionMode?: ExecutionModeTelemetryPayload;
}

/**
 * Harness 执行结果。
 */
export interface HarnessResult {
  /** 最终响应内容 */
  content: string;
  /** 循环状态 */
  loopState: LoopState;
  /** 完整对话历史 */
  messages: UnifiedMessage[];
  /** 结构化日志 — AI 做了什么（工具调用、权限、循环控制） */
  log: HarnessLogEntry[];
}

/**
 * LLM 调用函数类型。
 */
export type ChatFunction = (
  messages: UnifiedMessage[],
  options: { tools: ToolDefinition[] },
) => Promise<LLMResponse>;

/**
 * LLM 流式调用函数类型。
 * callback 在每个 chunk 到达时调用，done=true 表示流结束。
 * 返回完整的 LLMResponse（包含 toolCalls、usage 等）。
 */
export type StreamFunction = (
  messages: UnifiedMessage[],
  callback: (chunk: string, done: boolean) => void,
  options: { tools: ToolDefinition[] },
) => Promise<LLMResponse>;
