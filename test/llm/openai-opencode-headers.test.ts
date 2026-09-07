import { describe, expect, it } from 'vitest';
import { OpenAIAdapter } from '../../src/llm/openai-adapter.js';

type RequestOptionsBuilder = (
  options: { sessionId?: string; requestTimeoutMs?: number },
  signal?: AbortSignal,
) => { signal?: AbortSignal; timeout: number; headers?: Record<string, string> };

function buildOpts(
  adapter: OpenAIAdapter,
  options: { sessionId?: string; requestTimeoutMs?: number } = {},
): ReturnType<RequestOptionsBuilder> {
  const build = (adapter as unknown as { buildRequestOptions: RequestOptionsBuilder }).buildRequestOptions;
  return build.call(adapter, options);
}

describe('OpenAIAdapter OpenCode request headers', () => {
  it('does not attach OpenCode headers for other providers', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseURL: 'https://integrate.api.nvidia.com/v1',
    });
    expect(buildOpts(adapter, { sessionId: 'sess-1' }).headers).toBeUndefined();
  });

  it('attaches x-opencode-session from options.sessionId', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test-key',
      model: 'omen-alpha',
      baseURL: 'https://opencode.ai/zen/go/v1',
    });
    expect(buildOpts(adapter, { sessionId: 'web-session-42' }).headers).toEqual({
      'x-opencode-session': 'web-session-42',
      'x-opencode-client': 'iceCoder',
    });
  });

  it('uses a stable adapter fallback when sessionId is omitted', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test-key',
      model: 'omen-alpha',
      baseURL: 'https://opencode.ai/zen/go/v1',
    });
    const first = buildOpts(adapter).headers;
    const second = buildOpts(adapter).headers;
    expect(first?.['x-opencode-session']).toBeTruthy();
    expect(first?.['x-opencode-session']).toBe(second?.['x-opencode-session']);
    expect(first?.['x-opencode-client']).toBe('iceCoder');
  });
});
