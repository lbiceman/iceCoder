/**
 * 解析 provider.modelName 中的逗号分隔多模型名。
 */

import type { ProviderConfig } from '../web/types.js';

/** 将逗号分隔的模型名字符串解析为去重后的非空数组。 */
export function parseModelNames(modelName: string | undefined | null): string[] {
  if (!modelName || !modelName.trim()) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of modelName.split(',')) {
    const name = part.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/** 解析当前 provider 应使用的单个模型名（API 调用 / 展示用）。 */
export function resolveActiveModelName(provider: Pick<ProviderConfig, 'modelName' | 'activeModelName'>): string {
  const names = parseModelNames(provider.modelName);
  if (names.length === 0) return (provider.modelName ?? '').trim();
  const active = provider.activeModelName?.trim();
  if (active && names.includes(active)) return active;
  return names[0];
}

/** 规范化 activeModelName，确保落在 modelName 解析结果内。 */
export function normalizeProviderActiveModel<T extends Pick<ProviderConfig, 'modelName' | 'activeModelName'>>(
  provider: T,
): T {
  const names = parseModelNames(provider.modelName);
  if (names.length === 0) return provider;
  const active = provider.activeModelName?.trim();
  const resolved = active && names.includes(active) ? active : names[0];
  if (resolved === active) return provider;
  return { ...provider, activeModelName: resolved };
}
