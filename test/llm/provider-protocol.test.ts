import { describe, expect, it } from 'vitest';

import {
  looksLikeAnthropicApiUrl,
  invalidProviderApiModeError,
  resolveProviderProtocol,
} from '../../src/llm/provider-protocol.js';

describe('looksLikeAnthropicApiUrl', () => {
  it('recognizes official hosts', () => {
    expect(looksLikeAnthropicApiUrl('https://api.anthropic.com')).toBe(true);
    expect(looksLikeAnthropicApiUrl('https://api.anthropic.com/v1')).toBe(true);
    expect(looksLikeAnthropicApiUrl('https://gateway.anthropic.com/v1')).toBe(true);
  });

  it('recognizes an explicit /v1/messages path on custom hosts', () => {
    expect(looksLikeAnthropicApiUrl('https://proxy.example.com/v1/messages')).toBe(true);
    expect(looksLikeAnthropicApiUrl('https://proxy.example.com/anthropic/v1/messages')).toBe(true);
  });

  it('does not treat OpenAI-compatible URLs as Anthropic', () => {
    expect(looksLikeAnthropicApiUrl('https://api.openai.com/v1')).toBe(false);
    expect(looksLikeAnthropicApiUrl('https://openrouter.ai/api/v1')).toBe(false);
  });
});

describe('resolveProviderProtocol', () => {
  it('uses explicit apiMode over URL heuristics', () => {
    expect(resolveProviderProtocol({
      apiUrl: 'https://api.anthropic.com',
      apiMode: 'chat_completions',
    })).toBe('openai');
    expect(resolveProviderProtocol({
      apiUrl: 'https://proxy.example.com',
      apiMode: 'anthropic_messages',
    })).toBe('anthropic_messages');
  });

  it('falls back to Anthropic for official URLs when apiMode is omitted', () => {
    expect(resolveProviderProtocol({
      apiUrl: 'https://api.anthropic.com/v1',
    })).toBe('anthropic_messages');
  });

  it('defaults other providers to OpenAI-compatible', () => {
    expect(resolveProviderProtocol({
      apiUrl: 'https://api.openai.com/v1',
    })).toBe('openai');
  });
});

describe('invalidProviderApiModeError', () => {
  it('accepts known modes and empty values', () => {
    expect(invalidProviderApiModeError(undefined)).toBeNull();
    expect(invalidProviderApiModeError('')).toBeNull();
    expect(invalidProviderApiModeError('chat_completions')).toBeNull();
    expect(invalidProviderApiModeError('responses')).toBeNull();
    expect(invalidProviderApiModeError('anthropic_messages')).toBeNull();
  });

  it('rejects unknown modes', () => {
    expect(invalidProviderApiModeError('claude')).toContain('anthropic_messages');
  });
});
