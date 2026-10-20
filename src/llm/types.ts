/**
 * LLM 提供者适配层的类型定义。
 * 定义统一消息格式、响应类型、提供者适配器接口以及配置类型。
 */

import type { ReasoningEffort } from './reasoning-effort.js';

/**
 * 统一消息中的内容块（文本或图片）。
 */
export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  imageUrl?: string;
}

/**
 * 所有 LLM 交互中使用的统一消息格式。
 */
/**
 * 发送管道封存来源：
 * - toolBudget：旧版按 3000 字符常驻封存（仅存在于历史会话，加载时解除）
 * - subAgent：旧子代理摘要
 * - resultBudget：超限结果落盘失败，content 留原文、封存为注入视图
 * - pressureClear：上下文压力下清理的旧结果占位
 * - compaction：硬压缩为省空间缩短的视图
 *
 * 封存只改发给模型的视图，content 始终保留写入时的结果。
 */
export type ApiSealedBy = 'toolBudget' | 'subAgent' | 'resultBudget' | 'pressureClear' | 'compaction';

/**
 * 注入策略：full 原样；page 连续行分页；head/head_tail/tail 按字符裁剪；
 * range_error 范围超限被拒；omitted 本轮上下文预算用尽，只注入恢复指引
 */
export type ToolResultStrategy = 'full' | 'page' | 'head' | 'head_tail' | 'tail' | 'range_error' | 'omitted';

/** 工具结果注入上下文时的记录（随 checkpoint 持久化，用于重读识别与清理占位） */
export interface ToolResultMeta {
  toolName: string;
  strategy: ToolResultStrategy;
  originalChars: number;
  originalTokens: number;
  injectedChars: number;
  injectedTokens: number;
  /** read_file 路径（调用方原样） */
  path?: string;
  /** read_file 实际返回的行 */
  lines?: { start: number; end: number; total: number };
  /** read_file 请求范围内未返回的行 */
  omittedLines?: Array<[number, number]>;
  /** read_file 视图格式（硬压缩按行重新分页时用） */
  page?: { numbered: boolean; headerLines: number; requestedEnd: number };
  /** 字符裁剪时省略的区间 [start, end) */
  omittedChars?: [number, number];
  /** 完整原文落盘路径 */
  spillPath?: string;
  /** 本次读取补回了哪条结果省略 / 清理掉的内容 */
  rereadOf?: string;
}

export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /** @deprecated 历史兼容；发送 API 前会剥离，不再写入新消息 */
  reasoningContent?: string;
  /** 首次送入 API 时封存的正文；之后字节不变，保证前缀缓存 */
  apiSealedContent?: string;
  /** 封存来源；与 {@link apiSealedContent} 成对写入，避免靠正文 marker 推断 */
  apiSealedBy?: ApiSealedBy;
  /** tool 消息：注入规模、省略范围与原文引用 */
  toolResultMeta?: ToolResultMeta;
  /** C 类纠偏注入：硬压缩时保留在 recent 后缀，避免 lifecycle/recovery 提示被摘要丢弃 */
  preserveOnCompaction?: boolean;
  /** 连续失败阶梯 ephemeral 注入；meaningful_progress 后由 Harness 移除 */
  ephemeralFailureRecovery?: 'light' | 'evidence' | 'strong';
  /** 运行中 /also 注入的用户备注；与主任务 user 消息同等写入 canonical 历史 */
  alsoNote?: boolean;
}

/**
 * 表示 LLM 发起的工具/函数调用。
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

/**
 * 可提供给 LLM 的工具定义。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
}

/**
 * LLM 调用的响应。
 */
export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  /** 当轮 API 返回的思考文本；仅运行时/前端展示，不入历史、不回传 API */
  reasoningContent?: string;
}

/**
 * LLM 调用的 Token 使用统计。
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  provider: string;
  /** prompt cache 读取的 token 数（DeepSeek prompt_cache_hit_tokens；OpenAI cached 分项） */
  cacheReadTokens?: number;
  /** 未命中缓存的输入 token（DeepSeek prompt_cache_miss_tokens；OpenAI 可由 prompt_tokens - cached_tokens 推导） */
  cacheMissTokens?: number;
  /** prompt cache 写入的 token 数 */
  cacheCreationTokens?: number;
}

/**
 * 流式分片：content 为可见正文；reasoning 为思考链（仅展示，不进历史）。
 */
export type StreamCallbackChunk = string | { channel: 'reasoning'; delta: string };

/**
 * LLM 流式响应的回调类型。
 */
export type StreamCallback = (chunk: StreamCallbackChunk, done: boolean) => void;

/**
 * Token 账本分类。未设时记为 unknown。
 */
export type TokenUsageSource =
  | 'chat'
  | 'compaction'
  | 'memory_extract'
  | 'memory_recall'
  | 'memory_dream'
  | 'step_review'
  | 'image_read'
  | 'sub_agent'
  | 'unknown';

/**
 * LLM 调用选项，支持通用参数和提供者特定参数。
 */
export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  tools?: ToolDefinition[];
  /** Token 账本来源；统计页按调用记账，与会话文件无关 */
  usageSource?: TokenUsageSource;
  /** 子 Agent 调用时的 agentId 与类型；主 Agent 为空 */
  agentId?: string;
  agentType?: string;
  /**
   * 用户中断信号 — 触发时 provider 应尽快断开正在进行的 HTTP/流。
   * 由调用方通过 options.signal 传入（每轮 LLM 调用各带自己的 AbortSignal）；
   * provider 不需要、也不应自行清理监听。
   */
  signal?: AbortSignal | null;
  /** 单次 HTTP 请求超时（ms）；未设置时使用适配器构造时的默认值 */
  requestTimeoutMs?: number;
  /**
   * 当前会话 ID。配置了 `headers` 且值为 `{{sessionId}}` 时写入对应请求头；
   * 未设置时由适配器生成稳定兜底值。
   */
  sessionId?: string;
  /** 为 true 时跳过上层 LLMAdapter 的指数退避重试（Dream 等长请求用） */
  skipRetry?: boolean;
  /** 为 true 时 API 报错后不自动 strip 图片重试（如 image_read 必须看到原图） */
  skipVisionFallback?: boolean;
  /**
   * 当前请求的推理强度档位（须落在该 provider 配置的逗号列表中）。
   * Chat Completions 写入 reasoning_effort；Responses API 写入 reasoning.effort；
   * Anthropic Messages 写入 thinking。
   */
  reasoningEffort?: ReasoningEffort;
  [key: string]: any;
}

/**
 * 提供者适配器接口 - 每个 LLM 提供者实现此接口。
 */
export interface ProviderAdapter {
  name: string;
  chat(messages: UnifiedMessage[], options: LLMOptions): Promise<LLMResponse>;
  stream(messages: UnifiedMessage[], callback: StreamCallback, options: LLMOptions): Promise<LLMResponse>;
  countTokens(text: string): Promise<number>;
}

/**
 * LLM 调用的重试配置。
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
}

/**
 * LLM 适配器统一接口，所有智能体通过此接口与 LLM 交互。
 */
export interface LLMAdapterInterface {
  chat(messages: UnifiedMessage[], options?: LLMOptions): Promise<LLMResponse>;
  stream(messages: UnifiedMessage[], callback: StreamCallback, options?: LLMOptions): Promise<LLMResponse>;
  countTokens(text: string): Promise<number>;
  setAbortSignal?(signal: AbortSignal | null): void;
}
