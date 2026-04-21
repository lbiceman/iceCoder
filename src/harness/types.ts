/**
 * Harness 层类型定义。
 * Harness 是"软件 ←→ 模型"的机模交互层，
 * 负责上下文组装、工具权限、循环控制和可靠性。
 */

import type { UnifiedMessage, ToolDefinition, LLMResponse } from '../llm/types.js';
import type { HarnessLogEntry } from './logger.js';

// ─── 上下文组装 ───

/**
 * 上下文组装配置，决定"喂什么"给模型。
 */
export interface ContextAssemblyConfig {
  /** 系统提示词 */
  systemPrompt: string;
  /** 可用工具定义 */
  tools: ToolDefinition[];
  /** 环境信息（OS、当前目录等） */
  environment?: Record<string, string>;
  /** 记忆注入内容 */
  memories?: string[];
  /** 用户偏好 */
  userPreferences?: Record<string, any>;
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
  | 'model_done'       // 模型说 done
  | 'max_rounds'       // 达到最大轮次
  | 'token_budget'     // token 预算耗尽
  | 'timeout'          // 超时
  | 'user_abort'       // 用户中断
  | 'error';           // 错误

/**
 * 循环状态跟踪。
 */
export interface LoopState {
  /** 当前轮次 */
  currentRound: number;
  /** 累计输入 token */
  totalInputTokens: number;
  /** 累计输出 token */
  totalOutputTokens: number;
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
  /** 上下文压缩阈值（消息数量） */
  compactionThreshold?: number;
  /** 上下文压缩后保留的最近消息数 */
  compactionKeepRecent?: number;
  /** confirm 权限的回调：返回 true 允许，false 拒绝 */
  onConfirm?: (toolName: string, args: Record<string, any>) => Promise<boolean>;
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
