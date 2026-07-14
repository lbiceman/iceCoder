import { describe, it, expect, afterEach } from 'vitest';
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

// 隔离可能污染断言的候选环境变量（本机可能已 export DEEPSEEK_API_KEY 等）
const MANAGED_ENV_KEYS = [
  'DEFAULT_API_KEY',
  'BACKUP_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
];
const savedEnv: Record<string, string | undefined> = {};
for (const k of MANAGED_ENV_KEYS) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}

afterEach(() => {
  for (const k of MANAGED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    // 每个用例后再次清空，避免用例间串扰
    delete process.env[k];
  }
});

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

  it('is ready when apiKey comes from an environment variable', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-from-env-123';
    expect(isProviderReady(provider({ apiKey: '' }))).toBe(true);
    expect(isAppConfigReady({
      providers: [provider({ apiKey: 'sk-your-api-key-here' })],
    })).toBe(true);
  });

  it('is not ready when apiUrl is missing even if env key exists', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-from-env-123';
    expect(isProviderReady(provider({ apiKey: '', apiUrl: '' }))).toBe(false);
  });
});
