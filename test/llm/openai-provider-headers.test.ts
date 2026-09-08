import { describe, expect, it } from 'vitest';
import { OpenAIAdapter } from '../../src/llm/openai-adapter.js';

type RequestOptionsBuilder = (
  options: { sessionId?: string; model?: string; requestTimeoutMs?: number },
  signal?: AbortSignal,
) => { signal?: AbortSignal; timeout: number; headers?: Record<string, string> };

function buildOpts(
  adapter: OpenAIAdapter,
  options: { sessionId?: string; model?: string; requestTimeoutMs?: number } = {},
): ReturnType<RequestOptionsBuilder> {
  const build = (adapter as unknown as { buildRequestOptions: RequestOptionsBuilder }).buildRequestOptions;
  return build.call(adapter, options);
}

describe('OpenAIAdapter configured request headers', () => {
  it('does not attach extra headers when none are configured', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test-key',
      model: 'gpt-4o',
      baseURL: 'https://opencode.ai/zen/go/v1',
    });
    expect(buildOpts(adapter, { sessionId: 'sess-1' }).headers).toBeUndefined();
  });

  it('interpolates sessionId, providerId and model from config templates', () => {
    const adapter = new OpenAIAdapter({
      name: 'opencode-go',
      apiKey: 'test-key',
      model: 'omen-alpha',
      baseURL: 'https://opencode.ai/zen/go/v1',
      requestHeaders: {
        'x-opencode-session': '{{sessionId}}',
        'x-opencode-client': 'iceCoder',
        'x-model': '{{providerId}}/{{model}}',
      },
    });
    expect(buildOpts(adapter, { sessionId: 'web-session-42' }).headers).toEqual({
      'x-opencode-session': 'web-session-42',
      'x-opencode-client': 'iceCoder',
      'x-model': 'opencode-go/omen-alpha',
    });
  });

  it('uses a stable adapter fallback when sessionId is omitted', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test-key',
      model: 'omen-alpha',
      requestHeaders: { 'x-opencode-session': '{{sessionId}}' },
    });
    const first = buildOpts(adapter).headers;
    const second = buildOpts(adapter).headers;
    expect(first?.['x-opencode-session']).toBeTruthy();
    expect(first?.['x-opencode-session']).toBe(second?.['x-opencode-session']);
  });
});
