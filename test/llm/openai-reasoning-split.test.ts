import { describe, expect, it } from 'vitest';
import { OpenAIAdapter } from '../../src/llm/openai-adapter.js';

type ParamsBuilder = (
  messages: { role: string; content: string }[],
  options: Record<string, unknown>,
  stream: boolean,
) => Record<string, unknown>;

function buildParams(adapter: OpenAIAdapter, model: string, stream = true): Record<string, unknown> {
  const build = (adapter as unknown as { buildRequestParams: ParamsBuilder }).buildRequestParams;
  return build.call(adapter, [{ role: 'user', content: 'hi' }], { model }, stream);
}

describe('OpenAIAdapter reasoning_split (provider compatibility)', () => {
  it('does not send reasoning_split for gpt-4o', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test-key', model: 'gpt-4o' });
    const params = buildParams(adapter, 'gpt-4o');
    expect(params.extra_body).toBeUndefined();
  });

  it('does not send reasoning_split for deepseek-chat', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test-key', model: 'deepseek-chat' });
    const params = buildParams(adapter, 'deepseek-chat');
    expect(params.extra_body).toBeUndefined();
  });

  it('sends reasoning_split only for MiniMax models', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test-key', model: 'MiniMax-M3' });
    const params = buildParams(adapter, 'MiniMax-M3');
    expect(params.extra_body).toEqual({ reasoning_split: true });
  });

  it('extractStreamReasoningDelta returns empty for plain GPT delta', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test-key', model: 'gpt-4o' });
    const extract = (adapter as unknown as {
      extractStreamReasoningDelta: (d: Record<string, unknown>) => string;
    }).extractStreamReasoningDelta;
    expect(extract.call(adapter, { content: 'hello' })).toBe('');
    expect(extract.call(adapter, {})).toBe('');
  });
});
