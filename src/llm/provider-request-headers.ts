/**
 * Provider 额外 HTTP 请求头：配置字面量 + 有限占位符插值。
 * 占位符仅支持 {{sessionId}} / {{providerId}} / {{model}}，未知占位符直接报错。
 */

export const PROVIDER_HEADER_PLACEHOLDERS = ['sessionId', 'providerId', 'model'] as const;
export type ProviderHeaderPlaceholder = (typeof PROVIDER_HEADER_PLACEHOLDERS)[number];

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][\w]*)\s*\}\}/g;
const KNOWN_PLACEHOLDERS = new Set<string>(PROVIDER_HEADER_PLACEHOLDERS);

const RESERVED_HEADER_NAMES = new Set([
  'authorization',
  'content-type',
  'host',
  'cookie',
  'set-cookie',
  'connection',
  'transfer-encoding',
  'x-api-key',
]);

const MAX_HEADER_VALUE_CHARS = 4096;
const FORBIDDEN_HEADER_CHARS = /[\r\n\0]/;
const HEADER_NAME_RE = /^[\w!#$%&'*+.^`|~-]+$/;

export interface ProviderHeaderVars {
  sessionId: string;
  providerId: string;
  model: string;
}

export type ParseProviderHeadersResult =
  | { ok: true; headers?: Record<string, string> }
  | { ok: false; error: string };

function isReservedHeaderName(name: string): boolean {
  return RESERVED_HEADER_NAMES.has(name.trim().toLowerCase());
}

/** 扫描值中的未知 `{{name}}` 占位符。 */
export function listUnknownHeaderPlaceholders(value: string): string[] {
  const found = new Set<string>();
  const re = new RegExp(PLACEHOLDER_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const name = match[1];
    if (!KNOWN_PLACEHOLDERS.has(name)) found.add(name);
  }
  return [...found];
}

/** 将配置中的 headers 规范为 Record<string, string>；非法值返回 error。 */
export function parseProviderHeaders(raw: unknown): ParseProviderHeadersResult {
  if (raw == null) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'headers 必须是对象，键为头名、值为字符串' };
  }

  const out: Record<string, string> = {};
  const seenLower = new Map<string, string>();

  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawKey.trim();
    if (!name) {
      return { ok: false, error: 'headers 的键不能为空' };
    }
    if (!HEADER_NAME_RE.test(name) || FORBIDDEN_HEADER_CHARS.test(name)) {
      return { ok: false, error: `headers 键 ${name} 含非法字符` };
    }
    if (isReservedHeaderName(name)) {
      return { ok: false, error: `不允许覆盖保留请求头 ${name}` };
    }
    if (typeof rawValue !== 'string') {
      return { ok: false, error: `headers.${name} 必须是字符串` };
    }
    if (FORBIDDEN_HEADER_CHARS.test(rawValue)) {
      return { ok: false, error: `headers.${name} 不能包含换行或空字符` };
    }
    if (rawValue.length > MAX_HEADER_VALUE_CHARS) {
      return { ok: false, error: `headers.${name} 超过 ${MAX_HEADER_VALUE_CHARS} 字符上限` };
    }
    const lower = name.toLowerCase();
    const prev = seenLower.get(lower);
    if (prev && prev !== name) {
      return { ok: false, error: `headers 存在重复头（大小写不同）：${prev} 与 ${name}` };
    }
    const unknown = listUnknownHeaderPlaceholders(rawValue);
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `headers.${name} 含未知占位符 {{${unknown[0]}}}，仅支持 ${PROVIDER_HEADER_PLACEHOLDERS.join('、')}`,
      };
    }
    seenLower.set(lower, name);
    out[name] = rawValue;
  }

  if (Object.keys(out).length === 0) return { ok: true };
  return { ok: true, headers: out };
}

/** 替换值中的已知占位符；未知占位符抛错。 */
export function interpolateHeaderValue(template: string, vars: ProviderHeaderVars): string {
  return template.replace(new RegExp(PLACEHOLDER_RE.source, 'g'), (_all, name: string) => {
    if (!KNOWN_PLACEHOLDERS.has(name)) {
      throw new Error(
        `未知请求头占位符 {{${name}}}，仅支持 ${PROVIDER_HEADER_PLACEHOLDERS.join('、')}`,
      );
    }
    return vars[name as ProviderHeaderPlaceholder];
  });
}

/** 按当前请求变量解析配置头；无配置时返回 undefined。 */
export function resolveProviderRequestHeaders(
  templates: Record<string, string> | undefined,
  vars: ProviderHeaderVars,
): Record<string, string> | undefined {
  if (!templates || Object.keys(templates).length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(templates)) {
    out[name] = interpolateHeaderValue(template, vars);
  }
  return out;
}

/** 包装 fetch，在发出 HTTP 时合并当前解析后的请求头。 */
export function wrapFetchWithRequestHeaders(
  resolveHeaders: () => Record<string, string> | undefined,
  innerFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  return (input, init) => {
    const extras = resolveHeaders();
    if (!extras || Object.keys(extras).length === 0) {
      return innerFetch(input, init);
    }
    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(extras)) {
      headers.set(key, value);
    }
    return innerFetch(input, { ...init, headers });
  };
}
