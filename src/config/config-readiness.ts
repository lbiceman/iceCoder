/**
 * 判断主配置是否已完成（可供聊天 / 工具等能力使用）。
 */

import fs from 'fs/promises';
import type { IceCoderConfigFile, ProviderConfig } from '../web/types.js';

/** 默认占位 API Key（与 paths.ts / config.example.json 一致） */
export const PLACEHOLDER_API_KEY_MARKERS = [
  'sk-your-api-key-here',
  'your-api-key-here',
] as const;

export function isPlaceholderApiKey(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return PLACEHOLDER_API_KEY_MARKERS.some((marker) => lower.includes(marker));
}

/** 单个 provider 是否具备可用的 LLM 连接信息 */
export function isProviderReady(provider: ProviderConfig): boolean {
  if (!provider.apiUrl?.trim()) return false;
  if (!provider.apiKey?.trim() || isPlaceholderApiKey(provider.apiKey)) return false;
  if (!provider.modelName?.trim()) return false;
  return true;
}

/** 至少有一个可用 provider 时视为配置完成 */
export function isAppConfigReady(config: Pick<IceCoderConfigFile, 'providers'>): boolean {
  const providers = config.providers ?? [];
  if (providers.length === 0) return false;
  return providers.some(isProviderReady);
}

export async function readAppConfigReady(configPath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as IceCoderConfigFile;
    return isAppConfigReady(parsed);
  } catch {
    return false;
  }
}
