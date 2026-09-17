/**
 * Anthropic Messages API 鉴权头。
 * 使用 `x-api-key`，不发送 `Authorization: Bearer`。
 */

export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicAuthOptions {
  /** Anthropic-Version，默认 2023-06-01 */
  version?: string;
}

/**
 * 构造 Anthropic 必填鉴权头。
 * 调用方再合并 Content-Type 与用户配置的额外头。
 */
export function buildAnthropicAuthHeaders(
  apiKey: string,
  options?: AnthropicAuthOptions,
): Record<string, string> {
  const key = apiKey.trim();
  if (!key) {
    throw new Error('Anthropic API key is empty');
  }
  const version = options?.version?.trim() || DEFAULT_ANTHROPIC_VERSION;
  return {
    'x-api-key': key,
    'anthropic-version': version,
  };
}

/**
 * 把鉴权头与额外请求头合并：鉴权头优先，额外头不能覆盖 x-api-key。
 * anthropic-version 允许被额外头覆盖（便于接 beta / 网关）。
 */
export function mergeAnthropicRequestHeaders(
  apiKey: string,
  extraHeaders?: Record<string, string>,
  options?: AnthropicAuthOptions,
): Record<string, string> {
  const auth = buildAnthropicAuthHeaders(apiKey, options);
  const merged: Record<string, string> = { 'content-type': 'application/json', ...auth };
  if (!extraHeaders) return merged;
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (name.trim().toLowerCase() === 'x-api-key') continue;
    merged[name] = value;
  }
  return merged;
}
