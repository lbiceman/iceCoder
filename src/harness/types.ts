/**
 * Harness 层类型定义。
 * Harness 是"软件 ←→ 模型"的机模交互层，
 * 负责上下文组装、工具权限、循环控制和可靠性。
 */

import type { UnifiedMessage, ToolDefinition, LLMResponse } from '../llm/types.js';
import type { HarnessLogEntry } from './logger.js';
import type { MemoryManager } from '../memory/memory-manager.js';
import type { FileMemoryManager } from '../memory/file-memory/file-memory-manager.js';

// ─── 上下文组装 ───

/**
 * 上下文组装配置，决定"喂什么"给模型。
 */
export interface ContextAssemblyConfig {
  /** 系统提示词（静态部分，可缓存） */
  systemPrompt: string;
  /** 可用工具定义 */
  tools: ToolDefinition[];
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
  | 'timeout'            // 超时
  | 'user_abort'         // 用户中断
  | 'max_output_tokens'  // 输出 token 达到上限（finishReason === 'length'）
  | 'stop_hook'          // 停止钩子阻止继续
  | 'error';             // 错误

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
  /** 上下文压缩阈值（消息数量，向后兼容） */
  compactionThreshold?: number;
  /** 上下文压缩的 token 阈值（优先于消息数阈值，默认 80000） */
  compactionTokenThreshold?: number;
  /** 上下文压缩后保留的最近消息数 */
  compactionKeepRecent?: number;
  /** 是否启用 LLM 摘要压缩（默认 false，启用后压缩质量更高但消耗额外 token） */
  compactionEnableLLMSummary?: boolean;
  /** confirm 权限的回调：返回 true 允许，false 拒绝 */
  onConfirm?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
  /** 记忆文件目录路径（用于文件记忆预取，向后兼容） */
  memoryDir?: string;
  /** 文件记忆管理器（优先于 memoryDir，提供多级加载+异步预取+自动提取） */
  fileMemoryManager?: FileMemoryManager;
  /** 结构化记忆管理器（可选，用于运行时工作记忆） */
  memoryManager?: MemoryManager;
  /** 记忆检索的最大条数（默认 5） */
  memoryRetrieveLimit?: number;
}

/**
 * Harness 循环中每一步的事件回调。
 */
export interface HarnessStepEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'tool_denied' | 'tool_confirm' | 'compaction' | 'final';
  iteration?: number;
  content?: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolSuccess?: boolean;
  toolOutput?: string;
  toolError?: string;
  totalToolCalls?: number;
  stopReason?: StopReason;
  /** 本轮 LLM 调用的 token 用量 */
  tokenUsage?: { inputTokens: number; outputTokens: number };
  /** 累计 token 用量 */
  totalTokenUsage?: { inputTokens: number; outputTokens: number };
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
