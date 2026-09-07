/**
 * OpenCode Go / Zen 路由头。
 * 自 2026-09-06 起，`opencode.ai/zen/go` 要求请求携带 `x-opencode-session`，
 * 否则返回 400（无法做会话亲和路由）。
 */

const OPENCODE_SESSION_MAX_LEN = 128;
const OPENCODE_CLIENT = 'iceCoder';

/** 是否为 OpenCode Go / Zen 端点（按主机名判断，避免误伤其它兼容 API）。 */
export function isOpenCodeEndpoint(baseURL?: string | null): boolean {
  const raw = (baseURL ?? '').trim();
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return /(?:^|\/\/)(?:[\w-]+\.)?opencode\.ai(?:[:/]|$)/i.test(raw);
  }
}

/** 清洗并截断会话亲和值（OpenCode 侧上限 128）。 */
export function sanitizeOpenCodeSession(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const clamped = cleaned.slice(0, OPENCODE_SESSION_MAX_LEN);
  return clamped || 'iceCoder';
}

/**
 * 为 OpenCode 端点构造请求头；非 OpenCode URL 返回 undefined，避免泄漏到其它厂商。
 */
export function buildOpenCodeRequestHeaders(
  baseURL: string | undefined,
  sessionId?: string | null,
  fallbackSessionId?: string,
): Record<string, string> | undefined {
  if (!isOpenCodeEndpoint(baseURL)) return undefined;
  const raw = (typeof sessionId === 'string' && sessionId.trim())
    ? sessionId
    : (fallbackSessionId && fallbackSessionId.trim()) || 'iceCoder';
  return {
    'x-opencode-session': sanitizeOpenCodeSession(raw),
    'x-opencode-client': OPENCODE_CLIENT,
  };
}

/**
 * 包装 fetch：对 OpenCode 主机强制写入路由头，避免 SDK 某条路径漏传 defaultHeaders。
 */
export function wrapFetchWithOpenCodeHeaders(
  baseURL: string | undefined,
  resolveSessionId: () => string,
  innerFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  if (!isOpenCodeEndpoint(baseURL)) return innerFetch;
  return (input, init) => {
    const headers = new Headers(init?.headers);
    const extras = buildOpenCodeRequestHeaders(baseURL, resolveSessionId());
    if (extras) {
      for (const [key, value] of Object.entries(extras)) {
        headers.set(key, value);
      }
    }
    return innerFetch(input, { ...init, headers });
  };
}
