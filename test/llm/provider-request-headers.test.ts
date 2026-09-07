import { describe, expect, it } from 'vitest';
import {
  interpolateHeaderValue,
  listUnknownHeaderPlaceholders,
  parseProviderHeaders,
  resolveProviderRequestHeaders,
  wrapFetchWithRequestHeaders,
} from '../../src/llm/provider-request-headers.js';

const vars = {
  sessionId: 'sess-9',
  providerId: 'opencode-go',
  model: 'omen-alpha',
};

describe('parseProviderHeaders', () => {
  it('accepts missing and empty objects', () => {
    expect(parseProviderHeaders(undefined)).toEqual({ ok: true });
    expect(parseProviderHeaders(null)).toEqual({ ok: true });
    expect(parseProviderHeaders({})).toEqual({ ok: true });
  });

  it('keeps literal values and known placeholders', () => {
    expect(parseProviderHeaders({
      'x-opencode-session': '{{sessionId}}',
      'x-opencode-client': 'iceCoder',
    })).toEqual({
      ok: true,
      headers: {
        'x-opencode-session': '{{sessionId}}',
        'x-opencode-client': 'iceCoder',
      },
    });
  });

  it('rejects reserved names, non-strings, unknown placeholders, and CR/LF', () => {
    expect(parseProviderHeaders({ Authorization: 'Bearer x' }).ok).toBe(false);
    expect(parseProviderHeaders({ 'X-Foo': 1 }).ok).toBe(false);
    expect(parseProviderHeaders({ 'X-Foo': '{{userId}}' }).error).toContain('{{userId}}');
    expect(parseProviderHeaders({ 'X-Foo': 'a\r\nAuthorization: Bearer x' }).ok).toBe(false);
    expect(parseProviderHeaders({ 'X-Foo:Bar': 'z' }).ok).toBe(false);
  });
});

describe('interpolateHeaderValue', () => {
  it('leaves literals unchanged and substitutes known placeholders', () => {
    expect(interpolateHeaderValue('iceCoder', vars)).toBe('iceCoder');
    expect(interpolateHeaderValue('{{sessionId}}', vars)).toBe('sess-9');
    expect(interpolateHeaderValue('{{ sessionId }}', vars)).toBe('sess-9');
    expect(interpolateHeaderValue('p-{{providerId}}/{{model}}', vars)).toBe('p-opencode-go/omen-alpha');
  });

  it('throws on unknown placeholders', () => {
    expect(() => interpolateHeaderValue('{{userId}}', vars)).toThrow(/userId/);
  });
});

describe('listUnknownHeaderPlaceholders', () => {
  it('returns unknown names only', () => {
    expect(listUnknownHeaderPlaceholders('{{sessionId}}-{{foo}}')).toEqual(['foo']);
  });
});

describe('resolveProviderRequestHeaders', () => {
  it('returns undefined when empty', () => {
    expect(resolveProviderRequestHeaders(undefined, vars)).toBeUndefined();
    expect(resolveProviderRequestHeaders({}, vars)).toBeUndefined();
  });

  it('resolves mixed literal and placeholder headers', () => {
    expect(resolveProviderRequestHeaders({
      'x-opencode-session': '{{sessionId}}',
      'x-opencode-client': 'iceCoder',
    }, vars)).toEqual({
      'x-opencode-session': 'sess-9',
      'x-opencode-client': 'iceCoder',
    });
  });
});

describe('wrapFetchWithRequestHeaders', () => {
  it('merges resolved headers onto the request', async () => {
    const seen: Headers[] = [];
    const inner: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response('{}', { status: 200 });
    };
    const wrapped = wrapFetchWithRequestHeaders(
      () => ({ 'x-opencode-session': 'live-session', 'x-opencode-client': 'iceCoder' }),
      inner,
    );
    await wrapped('https://example.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-test' },
    });
    expect(seen[0].get('authorization')).toBe('Bearer sk-test');
    expect(seen[0].get('x-opencode-session')).toBe('live-session');
    expect(seen[0].get('x-opencode-client')).toBe('iceCoder');
  });
});
