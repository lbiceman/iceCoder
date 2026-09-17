import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ANTHROPIC_VERSION,
  buildAnthropicAuthHeaders,
  mergeAnthropicRequestHeaders,
} from '../../src/llm/anthropic-auth.js';

describe('buildAnthropicAuthHeaders', () => {
  it('sends x-api-key and default anthropic-version', () => {
    expect(buildAnthropicAuthHeaders(' sk-ant-test ')).toEqual({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': DEFAULT_ANTHROPIC_VERSION,
    });
  });

  it('allows overriding anthropic-version', () => {
    expect(buildAnthropicAuthHeaders('sk-ant-test', { version: '2024-10-22' })['anthropic-version'])
      .toBe('2024-10-22');
  });

  it('rejects an empty key', () => {
    expect(() => buildAnthropicAuthHeaders('  ')).toThrow(/empty/i);
  });
});

describe('mergeAnthropicRequestHeaders', () => {
  it('sets content-type and does not emit Authorization', () => {
    const headers = mergeAnthropicRequestHeaders('sk-ant-test', {
      'x-opencode-session': 'sess-1',
    });
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-api-key']).toBe('sk-ant-test');
    expect(headers['x-opencode-session']).toBe('sess-1');
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it('ignores extra x-api-key so auth cannot be overwritten', () => {
    const headers = mergeAnthropicRequestHeaders('sk-real', {
      'x-api-key': 'sk-forged',
      'X-Api-Key': 'sk-forged-2',
    });
    expect(headers['x-api-key']).toBe('sk-real');
  });

  it('lets extra headers override anthropic-version', () => {
    const headers = mergeAnthropicRequestHeaders('sk-ant-test', {
      'anthropic-version': '2024-10-22',
    });
    expect(headers['anthropic-version']).toBe('2024-10-22');
  });
});
