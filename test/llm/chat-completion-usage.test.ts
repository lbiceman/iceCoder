import { describe, expect, it } from 'vitest';
import { extractPromptCacheFromChatUsage } from '../../src/llm/chat-completion-usage.js';

describe('extractPromptCacheFromChatUsage', () => {
  it('parses DeepSeek prompt_cache_* fields', () => {
    expect(
      extractPromptCacheFromChatUsage({
        prompt_tokens: 10000,
        prompt_cache_hit_tokens: 8200,
        prompt_cache_miss_tokens: 1800,
      }),
    ).toEqual({ cacheReadTokens: 8200, cacheMissTokens: 1800 });
  });

  it('parses OpenAI cached_tokens details', () => {
    expect(
      extractPromptCacheFromChatUsage({
        prompt_tokens: 5000,
        prompt_tokens_details: { cached_tokens: 4000 },
      }),
    ).toEqual({ cacheReadTokens: 4000, cacheMissTokens: 1000 });
  });

  it('returns empty for missing usage', () => {
    expect(extractPromptCacheFromChatUsage(undefined)).toEqual({});
    expect(extractPromptCacheFromChatUsage(null)).toEqual({});
  });
});
