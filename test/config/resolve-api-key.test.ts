import { describe, it, expect } from 'vitest';
import {
  envKeyCandidatesForProvider,
  getEffectiveApiKey,
  isPlaceholderApiKey,
  resolveProviderApiKey,
} from '../../src/config/resolve-api-key.js';
import type { ProviderConfig } from '../../src/web/types.js';

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'default',
    apiUrl: 'https://api.deepseek.com',
    apiKey: '',
    modelName: 'deepseek-chat',
    parameters: { temperature: 0.7 },
    isDefault: true,
    ...overrides,
  };
}

describe('isPlaceholderApiKey', () => {
  it('treats empty / placeholder as placeholder', () => {
    expect(isPlaceholderApiKey('')).toBe(true);
    expect(isPlaceholderApiKey('   ')).toBe(true);
    expect(isPlaceholderApiKey(undefined)).toBe(true);
    expect(isPlaceholderApiKey('sk-your-api-key-here')).toBe(true);
    expect(isPlaceholderApiKey('YOUR-API-KEY-HERE')).toBe(true);
  });

  it('treats a real key as valid', () => {
    expect(isPlaceholderApiKey('sk-real-1234567890')).toBe(false);
  });
});

describe('envKeyCandidatesForProvider', () => {
  it('derives {ID}_API_KEY with normalization', () => {
    expect(envKeyCandidatesForProvider({ id: 'deepseek-v4-flash', apiUrl: '' }))
      .toContain('DEEPSEEK_V4_FLASH_API_KEY');
  });

  it('derives vendor env from apiUrl hostname', () => {
    expect(envKeyCandidatesForProvider({ id: '', apiUrl: 'https://api.deepseek.com' }))
      .toEqual(['DEEPSEEK_API_KEY']);
    expect(envKeyCandidatesForProvider({ id: '', apiUrl: 'https://api.openai.com/v1' }))
      .toEqual(['OPENAI_API_KEY']);
    expect(envKeyCandidatesForProvider({ id: '', apiUrl: 'https://openrouter.ai/api/v1' }))
      .toEqual(['OPENROUTER_API_KEY']);
  });

  it('orders id-specific before vendor and de-dupes', () => {
    const c = envKeyCandidatesForProvider({ id: 'deepseek', apiUrl: 'https://api.deepseek.com' });
    expect(c).toEqual(['DEEPSEEK_API_KEY']);
  });

  it('keeps both when id and vendor differ', () => {
    const c = envKeyCandidatesForProvider({ id: 'work', apiUrl: 'https://api.openai.com/v1' });
    expect(c).toEqual(['WORK_API_KEY', 'OPENAI_API_KEY']);
  });

  it('skips vendor env for localhost / IP', () => {
    expect(envKeyCandidatesForProvider({ id: '', apiUrl: 'http://localhost:11434/v1' })).toEqual([]);
    expect(envKeyCandidatesForProvider({ id: '', apiUrl: 'http://127.0.0.1:8000/v1' })).toEqual([]);
  });
});

describe('resolveProviderApiKey', () => {
  it('prefers a valid configured key', () => {
    const r = resolveProviderApiKey(provider({ apiKey: 'sk-configured-123' }), {});
    expect(r).toEqual({ apiKey: 'sk-configured-123', source: 'config' });
  });

  it('falls back to {ID}_API_KEY when config is empty', () => {
    const r = resolveProviderApiKey(provider({ id: 'my-provider', apiKey: '' }), {
      MY_PROVIDER_API_KEY: 'sk-env-id',
    });
    expect(r).toEqual({ apiKey: 'sk-env-id', source: 'env', envVar: 'MY_PROVIDER_API_KEY' });
  });

  it('falls back to vendor env when id-specific missing', () => {
    const r = resolveProviderApiKey(provider({ id: 'x', apiKey: '' }), {
      DEEPSEEK_API_KEY: 'sk-env-vendor',
    });
    expect(r).toEqual({ apiKey: 'sk-env-vendor', source: 'env', envVar: 'DEEPSEEK_API_KEY' });
  });

  it('treats a placeholder config key as empty and falls back to env', () => {
    const r = resolveProviderApiKey(provider({ id: 'x', apiKey: 'sk-your-api-key-here' }), {
      DEEPSEEK_API_KEY: 'sk-env-vendor',
    });
    expect(r.source).toBe('env');
    expect(r.apiKey).toBe('sk-env-vendor');
  });

  it('id-specific takes precedence over vendor env', () => {
    const r = resolveProviderApiKey(provider({ id: 'primary', apiKey: '' }), {
      PRIMARY_API_KEY: 'sk-id',
      DEEPSEEK_API_KEY: 'sk-vendor',
    });
    expect(r.envVar).toBe('PRIMARY_API_KEY');
    expect(r.apiKey).toBe('sk-id');
  });

  it('returns empty when neither config nor env provides a key', () => {
    const r = resolveProviderApiKey(provider({ id: 'x', apiKey: '' }), {});
    expect(r).toEqual({ apiKey: '', source: 'config' });
  });

  it('ignores placeholder values coming from env', () => {
    const r = resolveProviderApiKey(provider({ id: 'x', apiKey: '' }), {
      DEEPSEEK_API_KEY: 'your-api-key-here',
    });
    expect(r.apiKey).toBe('');
  });

  it('getEffectiveApiKey returns just the string', () => {
    expect(getEffectiveApiKey(provider({ apiKey: 'sk-abc' }), {})).toBe('sk-abc');
    expect(getEffectiveApiKey(provider({ apiKey: '' }), { DEEPSEEK_API_KEY: 'sk-env' })).toBe('sk-env');
  });
});
