import { describe, expect, it } from 'vitest';
import {
  OpenAIAdapter,
  isOfficialOpenAiEndpoint,
  resolveOfficialOpenAiPromptCacheKey,
} from '../../src/llm/openai-adapter.js';

type ParamsBuilder = (
  messages: { role: string; content: string }[],
  options: Record<string, unknown>,
  stream: boolean,
) => Record<string, unknown>;

function buildParams(
  adapter: OpenAIAdapter,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  const build = (adapter as unknown as { buildRequestParams: ParamsBuilder }).buildRequestParams;
  return build.call(adapter, [{ role: 'user', content: 'hi' }], options, false);
}

describe('official OpenAI prompt_cache_key', () => {
  it('treats a missing base URL as api.openai.com', () => {
    expect(isOfficialOpenAiEndpoint(undefined)).toBe(true);
    expect(isOfficialOpenAiEndpoint('https://api.openai.com/v1')).toBe(true);
    expect(isOfficialOpenAiEndpoint('https://api.deepseek.com/v1')).toBe(false);
    expect(isOfficialOpenAiEndpoint('https://example.openai.azure.com')).toBe(false);
  });

  it('sends the session id only for official OpenAI', () => {
    expect(resolveOfficialOpenAiPromptCacheKey('https://api.openai.com/v1', ' sess-1 ')).toBe('sess-1');
    expect(resolveOfficialOpenAiPromptCacheKey('https://api.deepseek.com', 'sess-1')).toBeUndefined();
    expect(resolveOfficialOpenAiPromptCacheKey(undefined, '   ')).toBeUndefined();

    const openai = new OpenAIAdapter({ apiKey: 'test-key', model: 'gpt-4o' });
    expect(buildParams(openai, { sessionId: 'sess-1' }).prompt_cache_key).toBe('sess-1');
    expect(buildParams(openai, {}).prompt_cache_key).toBeUndefined();

    const deepseek = new OpenAIAdapter({
      apiKey: 'test-key',
      model: 'deepseek-v4',
      baseURL: 'https://api.deepseek.com/v1',
    });
    expect(buildParams(deepseek, { sessionId: 'sess-1' }).prompt_cache_key).toBeUndefined();
  });
});
