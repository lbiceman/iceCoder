import { afterEach, describe, expect, it } from 'vitest';

import { openAiAdapterConfigFromProvider, anthropicAdapterConfigFromProvider, createProviderAdapter } from '../../src/llm/provider-adapter-config.js';
import { OpenAIAdapter } from '../../src/llm/openai-adapter.js';
import { AnthropicAdapter } from '../../src/llm/anthropic-adapter.js';
import type { ProviderConfig } from '../../src/web/types.js';

describe('openAiAdapterConfigFromProvider', () => {
  const base: ProviderConfig = {
    id: 'mimo2.5-pro',
    apiUrl: 'https://example.com/v1',
    apiKey: 'key',
    modelName: 'mimo-v2-omni',
    parameters: { temperature: 0.7 },
    isDefault: true,
  };

  const MANAGED = ['MIMO2_5_PRO_API_KEY', 'EXAMPLE_API_KEY', 'DEEPSEEK_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  for (const k of MANAGED) { saved[k] = process.env[k]; delete process.env[k]; }
  afterEach(() => {
    for (const k of MANAGED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
      delete process.env[k];
    }
  });

  it('passes supportsVision from provider config', () => {
    const cfg = openAiAdapterConfigFromProvider({ ...base, supportsVision: true });
    expect(cfg.supportsVision).toBe(true);
  });

  it('defaults supportsVision to true when unset', () => {
    const cfg = openAiAdapterConfigFromProvider(base);
    expect(cfg.supportsVision).toBe(true);
  });

  it('uses configured apiKey when present', () => {
    const cfg = openAiAdapterConfigFromProvider(base);
    expect(cfg.apiKey).toBe('key');
  });

  it('falls back to {ID}_API_KEY env when apiKey empty', () => {
    process.env.MIMO2_5_PRO_API_KEY = 'sk-env-id';
    const cfg = openAiAdapterConfigFromProvider({ ...base, apiKey: '' });
    expect(cfg.apiKey).toBe('sk-env-id');
  });

  it('falls back to vendor env when apiKey is placeholder', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-env-vendor';
    const cfg = openAiAdapterConfigFromProvider({
      ...base,
      apiKey: 'sk-your-api-key-here',
      apiUrl: 'https://api.deepseek.com',
    });
    expect(cfg.apiKey).toBe('sk-env-vendor');
  });

  it('uses activeModelName when modelName lists multiple models', () => {
    const cfg = openAiAdapterConfigFromProvider({
      ...base,
      modelName: 'mimo2.5-pro,mimo-2.5',
      activeModelName: 'mimo-2.5',
    });
    expect(cfg.model).toBe('mimo-2.5');
  });

  it('passes provider headers through as requestHeaders', () => {
    const cfg = openAiAdapterConfigFromProvider({
      ...base,
      headers: {
        'x-opencode-session': '{{sessionId}}',
        'x-opencode-client': 'iceCoder',
      },
    });
    expect(cfg.requestHeaders).toEqual({
      'x-opencode-session': '{{sessionId}}',
      'x-opencode-client': 'iceCoder',
    });
  });

  it('omits requestHeaders when provider has none', () => {
    const cfg = openAiAdapterConfigFromProvider(base);
    expect(cfg.requestHeaders).toBeUndefined();
  });

  it('parses reasoningEffort comma list into adapter levels', () => {
    const cfg = openAiAdapterConfigFromProvider({
      ...base,
      reasoningEffort: 'low, high, max',
    });
    expect(cfg.reasoningEffortLevels).toEqual(['low', 'high', 'max']);
  });

  it('omits reasoningEffortLevels when provider leaves the field empty', () => {
    const cfg = openAiAdapterConfigFromProvider(base);
    expect(cfg.reasoningEffortLevels).toBeUndefined();
  });
});

describe('createProviderAdapter', () => {
  const openaiProvider: ProviderConfig = {
    id: 'default',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    modelName: 'gpt-4o',
    parameters: {},
  };

  it('builds OpenAIAdapter for chat_completions providers', () => {
    const adapter = createProviderAdapter(openaiProvider);
    expect(adapter).toBeInstanceOf(OpenAIAdapter);
    expect(adapter.name).toBe('default');
  });

  it('builds AnthropicAdapter when apiMode is anthropic_messages', () => {
    const adapter = createProviderAdapter({
      ...openaiProvider,
      id: 'claude',
      apiUrl: 'https://proxy.example.com',
      apiMode: 'anthropic_messages',
      modelName: 'claude-sonnet-4-5',
    });
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
    expect(adapter.name).toBe('claude');
  });

  it('builds AnthropicAdapter for api.anthropic.com even without apiMode', () => {
    const adapter = createProviderAdapter({
      ...openaiProvider,
      id: 'anthropic',
      apiUrl: 'https://api.anthropic.com',
      modelName: 'claude-sonnet-4-5',
    });
    expect(adapter).toBeInstanceOf(AnthropicAdapter);
  });
});

describe('anthropicAdapterConfigFromProvider', () => {
  it('keeps reasoningEffortLevels for Anthropic thinking mapping', () => {
    const cfg = anthropicAdapterConfigFromProvider({
      id: 'opencode-go-anthropic',
      apiUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'key',
      modelName: 'union-alpha',
      apiMode: 'anthropic_messages',
      parameters: { temperature: 1 },
      reasoningEffort: 'low,high,max',
    });
    expect(cfg.reasoningEffortLevels).toEqual(['low', 'high', 'max']);
  });
});
