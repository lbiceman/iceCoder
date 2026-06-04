import type { ProviderConfig } from '../web/types.js';

type RawProvider = ProviderConfig & { providerName?: unknown };

/**
 * 将 config.json 中的 provider 条目规范为当前 schema。
 * 兼容旧版仅有 `providerName`、无 `id` 的配置（全局旧包 + 新 config 的常见组合）。
 */
export function normalizeProvider(raw: RawProvider, index: number): ProviderConfig {
  const legacy =
    typeof raw.providerName === 'string' && raw.providerName.trim() !== ''
      ? raw.providerName.trim()
      : '';
  const id = raw.id?.trim() || legacy || `provider-${index + 1}`;
  const { providerName: _legacy, ...rest } = raw;
  return { ...rest, id };
}

export function normalizeProviders(providers: unknown): ProviderConfig[] {
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers.map((p, index) => normalizeProvider(p as RawProvider, index));
}
