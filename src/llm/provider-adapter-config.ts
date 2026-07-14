import type { ProviderConfig } from '../web/types.js';
import type { OpenAIAdapterConfig } from './openai-adapter.js';
import { getModelMaxOutputTokens, resolveOpenAiRequestTimeoutMs } from '../config/model-capabilities.js';
import { resolveProviderApiKey } from '../config/resolve-api-key.js';

/** 将 data/config.json 中的 provider 条目转为 OpenAIAdapter 构造参数。 */
export function openAiAdapterConfigFromProvider(provider: ProviderConfig): OpenAIAdapterConfig {
  const maxTokens = provider.parameters.maxTokens ?? getModelMaxOutputTokens(provider.modelName);
  const rt = resolveOpenAiRequestTimeoutMs(provider);
  const apiMode = provider.apiMode ?? provider.parameters.apiMode;
  // config 未填有效 Key 时回退环境变量（不落盘）
  const apiKey = resolveProviderApiKey(provider).apiKey || provider.apiKey;
  return {
    name: provider.id,
    apiKey,
    baseURL: provider.apiUrl,
    model: provider.modelName,
    temperature: provider.parameters.temperature,
    maxTokens,
    topP: provider.parameters.topP,
    supportsVision: provider.supportsVision ?? true,
    ...(apiMode === 'responses' || apiMode === 'chat_completions' ? { apiMode } : {}),
    ...(rt !== undefined ? { timeout: rt } : {}),
  };
}
