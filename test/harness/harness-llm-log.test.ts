import { describe, expect, it } from 'vitest';

import { isRetryableError } from '../../src/harness/harness-llm-log.js';

describe('isRetryableError (P0-C)', () => {
  it('returns true for OpenAI-style "Connection error."', () => {
    expect(isRetryableError(new Error('OpenAI API Error [undefined]: Connection error.'))).toBe(true);
  });

  it('returns true for ECONNRESET / socket hang up family', () => {
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError(new Error('Connection closed unexpectedly'))).toBe(true);
    expect(isRetryableError(new Error('Connection aborted'))).toBe(true);
    expect(isRetryableError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isRetryableError(new Error('ENOTFOUND api.minimaxi.com'))).toBe(true);
  });

  it('returns true for rate-limit / 5xx markers', () => {
    expect(isRetryableError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRetryableError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isRetryableError(new Error('overloaded'))).toBe(true);
  });

  it('returns false for non-retryable errors', () => {
    expect(isRetryableError(new Error('Invalid API key'))).toBe(false);
    expect(isRetryableError(new Error('context_length_exceeded'))).toBe(false);
    expect(isRetryableError('plain string')).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});
