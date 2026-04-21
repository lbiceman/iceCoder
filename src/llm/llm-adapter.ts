/**
 * LLM 适配器 - LLM 提供者交互的统一接口。
 * 实现提供者注册、委托、带指数退避的重试逻辑以及 token 使用跟踪。
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8, 19.9, 19.10
 */

import type {
  LLMAdapterInterface,
  LLMOptions,
  LLMResponse,
  ProviderAdapter,
  RetryConfig,
  StreamCallback,
  TokenUsage,
  UnifiedMessage,
} from './types.js';
import { TokenCounter } from './token-counter.js';

/**
 * 默认重试配置。
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
};

/**
 * 触发重试的网络错误代码。
 */
const RETRYABLE_ERROR_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EPIPE', 'EAI_AGAIN'];

/**
 * 触发重试的 HTTP 状态码（服务器错误 + 速率限制）。
 */
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504, 408];

/**
 * 表示可重试错误的错误消息模式。
 */
const RETRYABLE_MESSAGE_PATTERNS = [
  'rate limit',
  'too many requests',
  'overloaded',
  'capacity',
  'temporarily unavailable',
  'service unavailable',
  'internal server error',
  'bad gateway',
  'gateway timeout',
  'request timeout',
  'connection reset',
  'socket hang up',
  'ECONNABORTED',
  'network error',
  'fetch failed',
];

/**
 * 判断错误是否可重试（网络错误、服务器错误、速率限制）。
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    // 检查错误代码（Node.js 网络错误）
    const code = (error as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_ERROR_CODES.includes(code)) {
      return true;
    }

    // 检查 HTTP 状态码
    const anyError = error as any;
    const status = anyError.status || anyError.statusCode;
    if (status && RETRYABLE_STATUS_CODES.includes(status)) {
      return true;
    }

    // 检查错误消息模式
    const lowerMessage = error.message.toLowerCase();
    for (const pattern of RETRYABLE_MESSAGE_PATTERNS) {
      if (lowerMessage.includes(pattern)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * LLMAdapter 类，实现 LLMAdapterInterface。
 * 管理提供者适配器、委托调用、处理重试并跟踪 token 使用。
 */
export class LLMAdapter implements LLMAdapterInterface {
  private providers: Map<string, ProviderAdapter> = new Map();
  private defaultProvider: string = '';
  private tokenCounter: TokenCounter = new TokenCounter();
  private retryConfig: RetryConfig;

  constructor(retryConfig?: Partial<RetryConfig>) {
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
  }

  /**
   * 注册提供者适配器。适配器按其名称存储。
   */
  registerProvider(adapter: ProviderAdapter): void {
    this.providers.set(adapter.name, adapter);
  }

  /**
   * 按名称设置默认提供者。如果提供者未注册则抛出错误。
   */
  setDefaultProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider adapter "${name}" is not registered`);
    }
    this.defaultProvider = name;
  }

  /**
   * 向配置的提供者发送聊天请求。
   * 从 options.provider 或 defaultProvider 解析提供者。
   * 成功调用后记录 token 使用。
   * 在网络/速率限制错误时使用指数退避重试。
   */
  async chat(messages: UnifiedMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const provider = this.resolveProvider(options);

    const response = await this.withRetry(() => provider.chat(messages, options ?? {}));

    this.tokenCounter.record(response.usage);
    return response;
  }

  /**
   * 向配置的提供者发送流式聊天请求。
   * 从 options.provider 或 defaultProvider 解析提供者。
   * 成功调用后记录 token 使用。
   * 在网络/速率限制错误时使用指数退避重试。
   */
  async stream(
    messages: UnifiedMessage[],
    callback: StreamCallback,
    options?: LLMOptions,
  ): Promise<LLMResponse> {
    const provider = this.resolveProvider(options);

    const response = await this.withRetry(() => provider.stream(messages, callback, options ?? {}));

    this.tokenCounter.record(response.usage);
    return response;
  }

  /**
   * 计算给定文本的 token 数。
   * 如果可用则委托给默认提供者的 countTokens，
   * 否则使用简单估算（字符数 / 4）。
   */
  async countTokens(text: string): Promise<number> {
    if (this.defaultProvider && this.providers.has(this.defaultProvider)) {
      const provider = this.providers.get(this.defaultProvider)!;
      return provider.countTokens(text);
    }
    // 简单估算回退：大约每 4 个字符一个 token
    return Math.ceil(text.length / 4);
  }

  /**
   * 获取所有记录的 token 使用统计。
   */
  getTokenUsageStats(): TokenUsage[] {
    return this.tokenCounter.getStats();
  }

  /**
   * 从选项或默认值解析提供者适配器。
   * 如果提供者未注册则抛出描述性错误。
   */
  private resolveProvider(options?: LLMOptions): ProviderAdapter {
    const providerName = options?.provider as string | undefined;
    const name = providerName || this.defaultProvider;

    if (!name) {
      throw new Error('No provider specified and no default provider is set');
    }

    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Provider adapter "${name}" is not registered`);
    }

    return provider;
  }

  /**
   * 使用重试逻辑执行异步操作。
   * 使用带抖动的指数退避：delay = min(baseDelay * 2^attempt + jitter, maxDelay)。
   * 在网络错误、服务器错误 (5xx) 和速率限制 (429) 时重试。
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (attempt >= this.retryConfig.maxRetries || !isRetryableError(error)) {
          throw error;
        }

        // 带抖动的指数退避，避免惊群效应
        const baseDelay = this.retryConfig.baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * this.retryConfig.baseDelay;
        const delay = Math.min(baseDelay + jitter, this.retryConfig.maxDelay);

        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(
          `LLM 调用失败 (尝试 ${attempt + 1}/${this.retryConfig.maxRetries + 1}): ${errorMsg}. ` +
          `${delay.toFixed(0)}ms 后重试...`,
        );

        await this.sleep(delay);
      }
    }

    // 不应到达此处，但满足 TypeScript 类型检查
    throw lastError;
  }

  /**
   * 休眠指定的毫秒数。
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
