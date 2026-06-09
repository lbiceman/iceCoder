import { describe, expect, it } from 'vitest';

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

  it('passes supportsVision from provider config', () => {
    const cfg = openAiAdapterConfigFromProvider({ ...base, supportsVision: true });
    expect(cfg.supportsVision).toBe(true);
  });

  it('defaults supportsVision to true when unset', () => {
    const cfg = openAiAdapterConfigFromProvider(base);
    expect(cfg.supportsVision).toBe(true);
  });
});
