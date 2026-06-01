import { describe, it, expect } from 'vitest';
import {
  isAppConfigReady,
  isPlaceholderApiKey,
  isProviderReady,
} from '../../src/config/config-readiness.js';
import type { ProviderConfig } from '../../src/web/types.js';

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'default',
    apiUrl: 'https://api.deepseek.com',
    apiKey: 'sk-real-key-1234567890',
    modelName: 'deepseek-chat',
    parameters: { temperature: 0.7 },
    isDefault: true,
    ...overrides,
  };
}

describe('config-readiness', () => {
  it('treats placeholder api keys as not ready', () => {
    expect(isPlaceholderApiKey('sk-your-api-key-here')).toBe(true);
    expect(isPlaceholderApiKey('sk-real-key')).toBe(false);
  });

  it('requires url, key, and model for a provider', () => {
    expect(isProviderReady(provider())).toBe(true);
    expect(isProviderReady(provider({ apiKey: 'sk-your-api-key-here' }))).toBe(false);
    expect(isProviderReady(provider({ modelName: '' }))).toBe(false);
    expect(isProviderReady(provider({ apiUrl: '' }))).toBe(false);
  });

  it('is ready when at least one provider is valid', () => {
    expect(isAppConfigReady({
      providers: [
        provider({ apiKey: 'sk-your-api-key-here' }),
        provider({ id: 'backup' }),
      ],
    })).toBe(true);

    expect(isAppConfigReady({
      providers: [provider({ apiKey: 'sk-your-api-key-here' })],
    })).toBe(false);
  });
});
