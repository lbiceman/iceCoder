import { afterEach, describe, expect, it } from 'vitest';

import { openAiAdapterConfigFromProvider } from '../../src/llm/provider-adapter-config.js';
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
});
