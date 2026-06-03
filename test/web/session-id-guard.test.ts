import { describe, expect, it } from 'vitest';
import { isSafeSessionId } from '../../src/web/session-id-guard.js';

describe('session-id-guard', () => {
  it('accepts uuid fragments and default id', () => {
    expect(isSafeSessionId('default')).toBe(true);
    expect(isSafeSessionId('abc12345')).toBe(true);
    expect(isSafeSessionId('a-b_c')).toBe(true);
  });

  it('rejects path traversal and separators', () => {
    expect(isSafeSessionId('../etc')).toBe(false);
    expect(isSafeSessionId('a/b')).toBe(false);
    expect(isSafeSessionId('a\\b')).toBe(false);
    expect(isSafeSessionId('')).toBe(false);
  });
});
