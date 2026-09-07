import { describe, expect, it } from 'vitest';
import {
  buildOpenCodeRequestHeaders,
  isOpenCodeEndpoint,
  sanitizeOpenCodeSession,
  wrapFetchWithOpenCodeHeaders,
} from '../../src/llm/opencode-headers.js';

describe('isOpenCodeEndpoint', () => {
  it('matches opencode.ai Go and Zen hosts', () => {
    expect(isOpenCodeEndpoint('https://opencode.ai/zen/go/v1')).toBe(true);
    expect(isOpenCodeEndpoint('https://opencode.ai/zen/v1')).toBe(true);
    expect(isOpenCodeEndpoint('https://api.opencode.ai/v1')).toBe(true);
  });

  it('does not match other OpenAI-compatible hosts', () => {
    expect(isOpenCodeEndpoint('https://integrate.api.nvidia.com/v1')).toBe(false);
    expect(isOpenCodeEndpoint('https://api.openai.com/v1')).toBe(false);
    expect(isOpenCodeEndpoint('https://example.com/opencode.ai/v1')).toBe(false);
    expect(isOpenCodeEndpoint('')).toBe(false);
    expect(isOpenCodeEndpoint(undefined)).toBe(false);
  });
});

describe('sanitizeOpenCodeSession', () => {
  it('keeps uuid-like ids', () => {
    expect(sanitizeOpenCodeSession('a1b2c3d4-e5f6-7890-abcd-ef1234567890'))
      .toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  });

  it('strips unsafe characters and clamps to 128', () => {
    expect(sanitizeOpenCodeSession(' sess/../id with spaces ')).toBe('sess-..-id-with-spaces');
    expect(sanitizeOpenCodeSession('x'.repeat(200))).toHaveLength(128);
  });

  it('falls back when empty after sanitizing', () => {
    expect(sanitizeOpenCodeSession('///')).toBe('iceCoder');
  });
});

describe('buildOpenCodeRequestHeaders', () => {
  it('returns undefined for non-OpenCode URLs', () => {
    expect(buildOpenCodeRequestHeaders('https://api.openai.com/v1', 'sess-1')).toBeUndefined();
  });

  it('prefers sessionId over fallback', () => {
    expect(buildOpenCodeRequestHeaders(
      'https://opencode.ai/zen/go/v1',
      'chat-session-9',
      'fallback-id',
    )).toEqual({
      'x-opencode-session': 'chat-session-9',
      'x-opencode-client': 'iceCoder',
    });
  });

  it('uses fallback then iceCoder when sessionId is missing', () => {
    expect(buildOpenCodeRequestHeaders(
      'https://opencode.ai/zen/go/v1',
      undefined,
      'adapter-fallback',
    )).toEqual({
      'x-opencode-session': 'adapter-fallback',
      'x-opencode-client': 'iceCoder',
    });
    expect(buildOpenCodeRequestHeaders('https://opencode.ai/zen/go/v1')).toEqual({
      'x-opencode-session': 'iceCoder',
      'x-opencode-client': 'iceCoder',
    });
  });
});

describe('wrapFetchWithOpenCodeHeaders', () => {
  it('injects routing headers on OpenCode requests', async () => {
    const seen: Headers[] = [];
    const inner: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response('{}', { status: 200 });
    };
    const wrapped = wrapFetchWithOpenCodeHeaders(
      'https://opencode.ai/zen/go/v1',
      () => 'live-session',
      inner,
    );
    await wrapped('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-test' },
    });
    expect(seen[0].get('authorization')).toBe('Bearer sk-test');
    expect(seen[0].get('x-opencode-session')).toBe('live-session');
    expect(seen[0].get('x-opencode-client')).toBe('iceCoder');
  });

  it('does not wrap non-OpenCode endpoints', () => {
    const inner = (async () => new Response('ok')) as typeof fetch;
    expect(wrapFetchWithOpenCodeHeaders('https://api.openai.com/v1', () => 'x', inner)).toBe(inner);
  });
});
