/**
 * 从 OpenAI 兼容 Chat Completions 的 `usage` 中解析前缀/Prompt 缓存分项。
 *
 * DeepSeek：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * OpenAI：`prompt_tokens_details.cached_tokens`
 */

export interface PromptCacheSlice {
  cacheReadTokens?: number;
  cacheMissTokens?: number;
}

export function extractPromptCacheFromChatUsage(raw: unknown): PromptCacheSlice {
  if (!raw || typeof raw !== 'object') return {};

  const u = raw as Record<string, unknown>;
  const dsHit = u.prompt_cache_hit_tokens;
  const dsMiss = u.prompt_cache_miss_tokens;

  if (typeof dsHit === 'number' && dsHit >= 0) {
    return {
      cacheReadTokens: dsHit,
      cacheMissTokens: typeof dsMiss === 'number' && dsMiss >= 0 ? dsMiss : undefined,
    };
  }

  const ptd = u.prompt_tokens_details;
  if (ptd && typeof ptd === 'object') {
    const pd = ptd as Record<string, unknown>;
    const cached = pd.cached_tokens;
    if (typeof cached === 'number' && cached > 0) {
      const prompt = u.prompt_tokens;
      const miss =
        typeof prompt === 'number' ? Math.max(0, prompt - cached) : undefined;
      return { cacheReadTokens: cached, cacheMissTokens: miss };
    }
  }

  return {};
}
