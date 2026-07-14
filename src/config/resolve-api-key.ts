/**
 * Provider API Key 解析：config.json 未填（或占位符）时回退环境变量。
 *
 * 设计目标（见 issue #42）：
 * - 不必把明文 Key 写进 config.json；已有 env 的用户可直接 `export`。
 * - env 的 Key 不落盘：解析发生在运行时，不会写回配置文件。
 *
 * 解析优先级（provider 维度）：
 * 1. config.json 中显式且非占位符的 `apiKey`
 * 2. `{PROVIDER_ID}_API_KEY`（id 大写，非字母数字→下划线），如 `deepseek-v4` → `DEEPSEEK_V4_API_KEY`
 * 3. 厂商级 env：由 `apiUrl` 主机名主标签推断，如 `api.deepseek.com` → `DEEPSEEK_API_KEY`
 */

import type { ProviderConfig } from '../web/types.js';

/** 默认占位 API Key（与 paths.ts / config.example.json 一致） */
export const PLACEHOLDER_API_KEY_MARKERS = [
  'sk-your-api-key-here',
  'your-api-key-here',
] as const;

export function isPlaceholderApiKey(apiKey: string | undefined | null): boolean {
  const trimmed = (apiKey ?? '').trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return PLACEHOLDER_API_KEY_MARKERS.some((marker) => lower.includes(marker));
}

/** provider.id → `{ID}_API_KEY` 环境变量名；无有效 id 时返回 null。 */
function envKeyFromProviderId(id: string | undefined): string | null {
  const normalized = (id ?? '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized ? `${normalized}_API_KEY` : null;
}

/**
 * 由 apiUrl 主机名推断厂商级 env 名（`{VENDOR}_API_KEY`）。
 * 取主机名去掉 `api`/`www` 前缀后的首标签，如：
 * - `api.deepseek.com` → `DEEPSEEK_API_KEY`
 * - `api.openai.com`   → `OPENAI_API_KEY`
 * - `openrouter.ai`    → `OPENROUTER_API_KEY`
 * 主机名为 IP / localhost 或无法解析时返回 null。
 */
function envKeyFromApiUrl(apiUrl: string | undefined): string | null {
  const raw = (apiUrl ?? '').trim();
  if (!raw) return null;

  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }
  if (!host || host === 'localhost') return null;
  // 纯 IP 不映射厂商
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return null;

  const labels = host.split('.').filter(Boolean);
  // 去掉常见前缀
  while (labels.length > 1 && (labels[0] === 'api' || labels[0] === 'www')) {
    labels.shift();
  }
  const vendor = labels[0];
  if (!vendor) return null;
  const normalized = vendor.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized ? `${normalized}_API_KEY` : null;
}

/** provider 的环境变量候选名（按优先级去重）。 */
export function envKeyCandidatesForProvider(provider: Pick<ProviderConfig, 'id' | 'apiUrl'>): string[] {
  const candidates: string[] = [];
  const byId = envKeyFromProviderId(provider.id);
  if (byId) candidates.push(byId);
  const byUrl = envKeyFromApiUrl(provider.apiUrl);
  if (byUrl && !candidates.includes(byUrl)) candidates.push(byUrl);
  return candidates;
}

export interface ResolvedApiKey {
  /** 解析后的有效 Key；无可用来源时为空字符串 */
  apiKey: string;
  /** 来源：显式配置 or 环境变量 */
  source: 'config' | 'env';
  /** source==='env' 时命中的环境变量名 */
  envVar?: string;
}

/**
 * 解析 provider 的实际可用 API Key。
 * config 中已填有效 Key → 直接使用；否则按候选名回退 env。
 */
export function resolveProviderApiKey(
  provider: Pick<ProviderConfig, 'id' | 'apiUrl' | 'apiKey'>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedApiKey {
  const configured = (provider.apiKey ?? '').trim();
  if (configured && !isPlaceholderApiKey(configured)) {
    return { apiKey: configured, source: 'config' };
  }

  for (const name of envKeyCandidatesForProvider(provider)) {
    const value = env[name]?.trim();
    if (value && !isPlaceholderApiKey(value)) {
      return { apiKey: value, source: 'env', envVar: name };
    }
  }

  return { apiKey: '', source: 'config' };
}

/** 便捷：仅取解析后的 Key 字符串（无来源信息）。 */
export function getEffectiveApiKey(
  provider: Pick<ProviderConfig, 'id' | 'apiUrl' | 'apiKey'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveProviderApiKey(provider, env).apiKey;
}
