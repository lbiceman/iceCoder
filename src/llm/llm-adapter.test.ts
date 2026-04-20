/**
 * Unit tests for LLM Adapter layer.
 * Tests LLMAdapter routing, retry logic, OpenAI/Anthropic adapter basics,
 * and error handling for unregistered providers.
 *
 * Requirements: 19.1, 19.7, 19.8, 20.2, 20.6, 21.2, 21.6
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LLMAdapter } from './llm-adapter.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import type {
  LLMOptions,
  LLMResponse,
  ProviderAdapter,
  StreamCallback,
  UnifiedMessage,
} from './types.js';

/**
 * Creates a mock ProviderAdapter for testing.
 */
function createMockProvider(
  name: string,
  chatResponse?: LLMResponse,
  streamResponse?: LLMResponse,
): ProviderAdapter {
  const defaultResponse: LLMResponse = chatResponse ?? {
    content: `Response from ${name}`,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: name },
    finishReason: 'stop',
  };

  const defaultStreamResponse: LLMResponse = streamResponse ?? {
    content: `Stream from ${name}`,
    usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, provider: name },
    finishReason: 'stop',
  };

  return {
    name,
    chat: vi.fn().mockResolvedValue(defaultResponse),
    stream: vi.fn().mockResolvedValue(defaultStreamResponse),
    countTokens: vi.fn().mockResolvedValue(42),
  };
}

describe('LLMAdapter', () => {
  let adapter: LLMAdapter;
  let mockOpenAI: ProviderAdapter;
  let mockAnthropic: ProviderAdapter;

  beforeEach(() => {
    adapter = new LLMAdapter({ maxRetries: 3, baseDelay: 100, maxDelay: 5000 });
    mockOpenAI = createMockProvider('openai');
    mockAnthropic = createMockProvider('anthropic');
  });

  const sampleMessages: UnifiedMessage[] = [
    { role: 'user', content: 'Hello' },
  ];

  describe('registerProvider() and setDefaultProvider()', () => {
    it('should register a provider and set it as default', () => {
      adapter.registerProvider(mockOpenAI);
      adapter.setDefaultProvider('openai');

      // Should not throw
      expect(() => adapter.setDefaultProvider('openai')).not.toThrow();
    });

    it('should throw when setting default to unregistered provider', () => {
      expect(() => adapter.setDefaultProvider('nonexistent')).toThrow(
        'Provider adapter "nonexistent" is not registered',
      );
    });
  });

  describe('chat() routing', () => {
    beforeEach(() => {
      adapter.registerProvider(mockOpenAI);
      adapter.registerProvider(mockAnthropic);
      adapter.setDefaultProvider('openai');
    });

    it('should route to default provider when no provider specified in options', async () => {
      const result = await adapter.chat(sampleMessages);

      expect(mockOpenAI.chat).toHaveBeenCalledWith(sampleMessages, {});
      expect(mockAnthropic.chat).not.toHaveBeenCalled();
      expect(result.content).toBe('Response from openai');
    });

    it('should route to specified provider via options.provider', async () => {
      const result = await adapter.chat(sampleMessages, { provider: 'anthropic' });

      expect(mockAnthropic.chat).toHaveBeenCalled();
      expect(mockOpenAI.chat).not.toHaveBeenCalled();
      expect(result.content).toBe('Response from anthropic');
    });
  });

  describe('stream() routing', () => {
    beforeEach(() => {
      adapter.registerProvider(mockOpenAI);
      adapter.registerProvider(mockAnthropic);
      adapter.setDefaultProvider('openai');
    });

    it('should route stream to default provider', async () => {
      const callback: StreamCallback = vi.fn();
      const result = await adapter.stream(sampleMessages, callback);

      expect(mockOpenAI.stream).toHaveBeenCalled();
      expect(result.content).toBe('Stream from openai');
    });

    it('should route stream to specified provider via options.provider', async () => {
      const callback: StreamCallback = vi.fn();
      const result = await adapter.stream(sampleMessages, callback, { provider: 'anthropic' });

      expect(mockAnthropic.stream).toHaveBeenCalled();
      expect(result.content).toBe('Stream from anthropic');
    });
  });

  describe('Error handling for unregistered provider', () => {
    it('should throw when no default provider is set and no provider specified', async () => {
      adapter.registerProvider(mockOpenAI);
      // Don't set default

      await expect(adapter.chat(sampleMessages)).rejects.toThrow(
        'No provider specified and no default provider is set',
      );
    });

    it('should throw when specified provider is not registered', async () => {
      adapter.registerProvider(mockOpenAI);
      adapter.setDefaultProvider('openai');

      await expect(
        adapter.chat(sampleMessages, { provider: 'nonexistent' }),
      ).rejects.toThrow('Provider adapter "nonexistent" is not registered');
    });
  });

  describe('Token usage recording', () => {
    beforeEach(() => {
      adapter.registerProvider(mockOpenAI);
      adapter.setDefaultProvider('openai');
    });

    it('should record token usage after successful chat call', async () => {
      await adapter.chat(sampleMessages);

      const stats = adapter.getTokenUsageStats();
      expect(stats).toHaveLength(1);
      expect(stats[0]).toEqual({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        provider: 'openai',
      });
    });

    it('should accumulate token usage across multiple calls', async () => {
      await adapter.chat(sampleMessages);
      await adapter.chat(sampleMessages);

      const stats = adapter.getTokenUsageStats();
      expect(stats).toHaveLength(2);
    });

    it('should record token usage after successful stream call', async () => {
      const callback: StreamCallback = vi.fn();
      await adapter.stream(sampleMessages, callback);

      const stats = adapter.getTokenUsageStats();
      expect(stats).toHaveLength(1);
      expect(stats[0].totalTokens).toBe(30);
    });
  });

  describe('Retry logic with exponential backoff', () => {
    beforeEach(() => {
      vi.useRealTimers();
      adapter = new LLMAdapter({ maxRetries: 3, baseDelay: 10, maxDelay: 5000 });
      adapter.registerProvider(mockOpenAI);
      adapter.setDefaultProvider('openai');
    });

    it('should retry on retryable errors and succeed', async () => {
      const retryableError = new Error('Connection refused');
      (retryableError as NodeJS.ErrnoException).code = 'ECONNREFUSED';

      const successResponse: LLMResponse = {
        content: 'Success after retry',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'openai' },
        finishReason: 'stop',
      };

      // Fail twice, then succeed
      (mockOpenAI.chat as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(retryableError)
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValueOnce(successResponse);

      const result = await adapter.chat(sampleMessages);
      expect(result.content).toBe('Success after retry');
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(3);
    });

    it('should retry on rate limit (429) errors', async () => {
      const rateLimitError = new Error('Rate limited');
      (rateLimitError as any).status = 429;

      const successResponse: LLMResponse = {
        content: 'Success after rate limit',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, provider: 'openai' },
        finishReason: 'stop',
      };

      (mockOpenAI.chat as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(successResponse);

      const result = await adapter.chat(sampleMessages);
      expect(result.content).toBe('Success after rate limit');
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry non-retryable errors', async () => {
      const nonRetryableError = new Error('Invalid API key');
      (nonRetryableError as any).status = 401;

      (mockOpenAI.chat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(nonRetryableError);

      await expect(adapter.chat(sampleMessages)).rejects.toThrow('Invalid API key');
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(1);
    });

    it('should throw after exhausting max retries', async () => {
      const retryableError = new Error('Timeout');
      (retryableError as NodeJS.ErrnoException).code = 'ETIMEDOUT';

      (mockOpenAI.chat as ReturnType<typeof vi.fn>).mockRejectedValue(retryableError);

      await expect(adapter.chat(sampleMessages)).rejects.toThrow('Timeout');
      // 1 initial + 3 retries = 4 calls
      expect(mockOpenAI.chat).toHaveBeenCalledTimes(4);
    });
  });
});

describe('OpenAIAdapter', () => {
  it('should have the correct name', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'fake-key',
      model: 'gpt-4',
    });
    expect(adapter.name).toBe('openai');
  });

  it('should estimate tokens using ~4 chars per token', async () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'fake-key',
      model: 'gpt-4',
    });

    // 20 characters → ceil(20/4) = 5 tokens
    const count = await adapter.countTokens('12345678901234567890');
    expect(count).toBe(5);

    // 7 characters → ceil(7/4) = 2 tokens
    const count2 = await adapter.countTokens('abcdefg');
    expect(count2).toBe(2);

    // Empty string → ceil(0/4) = 0 tokens
    const count3 = await adapter.countTokens('');
    expect(count3).toBe(0);
  });
});

describe('AnthropicAdapter', () => {
  it('should have the correct name', () => {
    const adapter = new AnthropicAdapter({
      apiKey: 'fake-key',
      model: 'claude-3-sonnet-20240229',
    });
    expect(adapter.name).toBe('anthropic');
  });

  it('should estimate tokens using ~4 chars per token', async () => {
    const adapter = new AnthropicAdapter({
      apiKey: 'fake-key',
      model: 'claude-3-sonnet-20240229',
    });

    // 20 characters → ceil(20/4) = 5 tokens
    const count = await adapter.countTokens('12345678901234567890');
    expect(count).toBe(5);

    // 7 characters → ceil(7/4) = 2 tokens
    const count2 = await adapter.countTokens('abcdefg');
    expect(count2).toBe(2);

    // Empty string → ceil(0/4) = 0 tokens
    const count3 = await adapter.countTokens('');
    expect(count3).toBe(0);
  });
});
