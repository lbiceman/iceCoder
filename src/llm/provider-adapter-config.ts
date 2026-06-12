import type { ProviderConfig } from '../web/types.js';
import type { OpenAIAdapterConfig } from './openai-adapter.js';
import { getModelMaxOutputTokens, resolveOpenAiRequestTimeoutMs } from '../web/routes/config.js';

/** 将 data/config.json 中的 provider 条目转为 OpenAIAdapter 构造参数。 */
export function openAiAdapterConfigFromProvider(provider: ProviderConfig): OpenAIAdapterConfig {
  const maxTokens = provider.parameters.maxTokens ?? getModelMaxOutputTokens(provider.modelName);
  const rt = resolveOpenAiRequestTimeoutMs(provider);
  return {
    name: provider.id,
    apiKey: provider.apiKey,
    baseURL: provider.apiUrl,
    model: provider.modelName,
    temperature: provider.parameters.temperature,
    maxTokens,
    topP: provider.parameters.topP,
    supportsVision: provider.supportsVision ?? true,
    ...(rt !== undefined ? { timeout: rt } : {}),
  };
}
