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
export interface UnifiedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
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
}

/**
 * LLM 调用的 Token 使用统计。
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  provider: string;
}

/**
 * LLM 流式响应的回调类型。
 */
export type StreamCallback = (chunk: string, done: boolean) => void;

/**
 * LLM 调用选项，支持通用参数和提供者特定参数。
 */
export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  tools?: ToolDefinition[];
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
}
