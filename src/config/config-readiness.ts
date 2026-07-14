/**
 * 判断主配置是否已完成（可供聊天 / 工具等能力使用）。
 */

import fs from 'fs/promises';
import type { IceCoderConfigFile, ProviderConfig } from '../web/types.js';
import {
  PLACEHOLDER_API_KEY_MARKERS,
  isPlaceholderApiKey,
  resolveProviderApiKey,
} from './resolve-api-key.js';

// 向后兼容：历史上占位符助手从本文件导出，保留 re-export 以免破坏既有引用与测试。
export { PLACEHOLDER_API_KEY_MARKERS, isPlaceholderApiKey };

/** 单个 provider 是否具备可用的 LLM 连接信息（apiKey 可来自环境变量） */
export function isProviderReady(provider: ProviderConfig): boolean {
  if (!provider.apiUrl?.trim()) return false;
  if (!resolveProviderApiKey(provider).apiKey) return false;
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
