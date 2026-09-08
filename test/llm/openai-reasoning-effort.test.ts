import { describe, expect, it } from 'vitest';
import { OpenAIAdapter } from '../../src/llm/openai-adapter.js';

type ParamsBuilder = (
  messages: { role: string; content: string }[],
  options: Record<string, unknown>,
  stream: boolean,
) => Record<string, unknown>;

function buildParams(
  adapter: OpenAIAdapter,
  options: Record<string, unknown> = {},
  stream = false,
): Record<string, unknown> {
  const build = (adapter as unknown as { buildRequestParams: ParamsBuilder }).buildRequestParams;
  return build.call(adapter, [{ role: 'user', content: 'hi' }], options, stream);
}

describe('OpenAIAdapter reasoningEffort', () => {
  it('omits reasoning_effort when the provider has no ladder', () => {
    const adapter = new OpenAIAdapter({ apiKey: 'test-key', model: 'omen-alpha' });
    const params = buildParams(adapter, { model: 'omen-alpha', reasoningEffort: 'xhigh' });
    expect(params.reasoning_effort).toBeUndefined();
  });

  it('sends configured ladder values for chat completions', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test-key',
      model: 'omen-alpha',
      reasoningEffortLevels: ['low', 'high', 'max'],
    });
    const params = buildParams(adapter, { model: 'omen-alpha', reasoningEffort: 'max' });
    expect(params.reasoning_effort).toBe('max');
  });

  it('clamps unknown UI levels onto the provider ladder', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test-key',
      model: 'omen-alpha',
      reasoningEffortLevels: ['low', 'high', 'max'],
    });
    const params = buildParams(adapter, { model: 'omen-alpha', reasoningEffort: 'medium' });
    expect(params.reasoning_effort).toBe('high');
  });

  it('keeps MiniMax reasoning_split when effort is also set', () => {
    const adapter = new OpenAIAdapter({
      apiKey: 'test-key',
      model: 'MiniMax-M3',
      reasoningEffortLevels: ['low', 'high', 'max'],
    });
    const params = buildParams(adapter, { model: 'MiniMax-M3', reasoningEffort: 'high' }, true);
    expect(params.reasoning_effort).toBe('high');
    expect(params.extra_body).toEqual({ reasoning_split: true });
  });
});
