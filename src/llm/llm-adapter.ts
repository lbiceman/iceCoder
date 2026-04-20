/**
 * LLM Adapter - Unified interface for LLM provider interactions.
 * Implements provider registration, delegation, retry logic with exponential backoff,
 * and token usage tracking.
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
 * Default retry configuration.
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelay: 1000,
  maxDelay: 30000,
};

/**
 * Network error codes that trigger retry.
 */
const RETRYABLE_ERROR_CODES = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'];

/**
 * Determines if an error is retryable (network errors or rate limit 429).
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && RETRYABLE_ERROR_CODES.includes(code)) {
      return true;
    }
    // Check for rate limit (HTTP 429) in error message or status
    const anyError = error as any;
    if (anyError.status === 429 || anyError.statusCode === 429) {
      return true;
    }
    if (error.message && error.message.includes('429')) {
      return true;
    }
  }
  return false;
}

/**
 * LLMAdapter class implementing LLMAdapterInterface.
 * Manages provider adapters, delegates calls, handles retries, and tracks token usage.
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
   * Register a provider adapter. The adapter is stored by its name.
   */
  registerProvider(adapter: ProviderAdapter): void {
    this.providers.set(adapter.name, adapter);
  }

  /**
   * Set the default provider by name. Throws if the provider is not registered.
   */
  setDefaultProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider adapter "${name}" is not registered`);
    }
    this.defaultProvider = name;
  }

  /**
   * Send a chat request to the configured provider.
   * Resolves provider from options.provider or defaultProvider.
   * Records token usage after successful call.
   * Retries on network/rate-limit errors with exponential backoff.
   */
  async chat(messages: UnifiedMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const provider = this.resolveProvider(options);

    const response = await this.withRetry(() => provider.chat(messages, options ?? {}));

    this.tokenCounter.record(response.usage);
    return response;
  }

  /**
   * Send a streaming chat request to the configured provider.
   * Resolves provider from options.provider or defaultProvider.
   * Records token usage after successful call.
   * Retries on network/rate-limit errors with exponential backoff.
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
   * Count tokens for the given text.
   * Delegates to the default provider's countTokens if available,
   * otherwise uses a simple estimation (chars / 4).
   */
  async countTokens(text: string): Promise<number> {
    if (this.defaultProvider && this.providers.has(this.defaultProvider)) {
      const provider = this.providers.get(this.defaultProvider)!;
      return provider.countTokens(text);
    }
    // Simple estimation fallback: approximately 4 characters per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Get all recorded token usage statistics.
   */
  getTokenUsageStats(): TokenUsage[] {
    return this.tokenCounter.getStats();
  }

  /**
   * Resolve the provider adapter from options or default.
   * Throws descriptive error if provider is not registered.
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
   * Execute an async operation with retry logic.
   * Uses exponential backoff: delay = min(baseDelay * 2^attempt, maxDelay).
   * Only retries on network errors (ECONNREFUSED, ETIMEDOUT) and rate limit (429).
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

        const delay = Math.min(
          this.retryConfig.baseDelay * Math.pow(2, attempt),
          this.retryConfig.maxDelay,
        );
        await this.sleep(delay);
      }
    }

    // This should not be reached, but satisfies TypeScript
    throw lastError;
  }

  /**
   * Sleep for the specified number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
