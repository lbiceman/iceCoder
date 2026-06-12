import { describe, expect, it } from 'vitest';
import { normalizeProvider, normalizeProviders } from '../../src/config/normalize-provider.js';

describe('normalizeProvider', () => {
  it('保留已有 id', () => {
    const p = normalizeProvider(
      {
        id: 'minimax-m3',
        apiUrl: 'https://api.example/v1',
        apiKey: 'sk-x',
        modelName: 'm3',
        parameters: {},
      },
      0,
    );
    expect(p.id).toBe('minimax-m3');
    expect((p as { providerName?: string }).providerName).toBeUndefined();
  });

  it('从 providerName 迁移 id', () => {
    const p = normalizeProvider(
      {
        providerName: 'openai',
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-x',
        modelName: 'gpt-4o',
        parameters: {},
        isDefault: true,
      } as Parameters<typeof normalizeProvider>[0],
      0,
    );
    expect(p.id).toBe('openai');
  });

  it('无 id 且无 providerName 时生成序号 id', () => {
    const p = normalizeProvider(
      {
        apiUrl: 'https://api.example/v1',
        apiKey: 'sk-x',
        modelName: 'm',
        parameters: {},
      } as Parameters<typeof normalizeProvider>[0],
      2,
    );
    expect(p.id).toBe('provider-3');
  });
});

describe('normalizeProviders', () => {
  it('非数组返回空列表', () => {
    expect(normalizeProviders(null)).toEqual([]);
  });
});
