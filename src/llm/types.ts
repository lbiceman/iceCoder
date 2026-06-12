/**
 * LLM 提供者适配层的类型定义。
 * 定义统一消息格式、响应类型、提供者适配器接口以及配置类型。
 */

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
/** 发送管道封存来源（tool 结果 budget / 子代理摘要） */
export type ApiSealedBy = 'toolBudget' | 'subAgent';

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
  /** C 类纠偏注入：硬压缩时保留在 recent 后缀，避免 lifecycle/recovery 提示被摘要丢弃 */
  preserveOnCompaction?: boolean;
  /** 连续失败阶梯 ephemeral 注入；meaningful_progress 后由 Harness 移除 */
  ephemeralFailureRecovery?: 'light' | 'evidence' | 'strong';
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
 * LLM 调用选项，支持通用参数和提供者特定参数。
 */
export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  tools?: ToolDefinition[];
  /**
   * 用户中断信号 — 触发时 provider 应尽快断开正在进行的 HTTP/流。
   * 由 LLMAdapter.stream/chat 从 setAbortSignal() 注入；provider 不需要、也不应自行清理监听。
   */
  signal?: AbortSignal | null;
  /** 单次 HTTP 请求超时（ms）；未设置时使用适配器构造时的默认值 */
  requestTimeoutMs?: number;
  /** 为 true 时跳过上层 LLMAdapter 的指数退避重试（Dream 等长请求用） */
  skipRetry?: boolean;
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
