/**
 * Provider 协议选择：OpenAI 兼容 vs Anthropic Messages。
 * apiMode 是显式开关；未填写时仅对 Anthropic 官方主机名做启发式识别。
 */

export const PROVIDER_API_MODES = ['chat_completions', 'responses', 'anthropic_messages'] as const;
export type ProviderApiMode = (typeof PROVIDER_API_MODES)[number];

export type ProviderProtocol = 'openai' | 'anthropic_messages';

const API_MODE_SET = new Set<string>(PROVIDER_API_MODES);

export function isProviderApiMode(value: string): value is ProviderApiMode {
  return API_MODE_SET.has(value);
}

/** 非法 apiMode 的错误文案；空/缺省返回 null。 */
export function invalidProviderApiModeError(raw: unknown): string | null {
  if (raw == null) return null;
  const value = String(raw).trim();
  if (!value) return null;
  if (isProviderApiMode(value)) return null;
  return `apiMode 仅支持 ${PROVIDER_API_MODES.join('、')}`;
}

export function parseProviderApiMode(raw: unknown): ProviderApiMode | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return isProviderApiMode(value) ? value : undefined;
}

/** api.anthropic.com 或路径已是 /v1/messages 时视为原生 Anthropic 协议。 */
export function looksLikeAnthropicApiUrl(apiUrl: string | undefined): boolean {
  const raw = apiUrl?.trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return true;
    const path = url.pathname.replace(/\/+$/, '').toLowerCase();
    return path.endsWith('/v1/messages') || path === '/messages';
  } catch {
    return /anthropic\.com/i.test(raw);
  }
}

export function resolveProviderProtocol(input: {
  apiUrl?: string;
  apiMode?: string;
  parameters?: { apiMode?: string; [key: string]: unknown };
}): ProviderProtocol {
  const apiMode = parseProviderApiMode(input.apiMode ?? input.parameters?.apiMode);
  if (apiMode === 'anthropic_messages') return 'anthropic_messages';
  if (apiMode === 'chat_completions' || apiMode === 'responses') return 'openai';
  if (looksLikeAnthropicApiUrl(input.apiUrl)) return 'anthropic_messages';
  return 'openai';
}
