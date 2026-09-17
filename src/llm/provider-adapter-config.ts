import type { ProviderConfig } from '../web/types.js';
import type { OpenAIAdapterConfig } from './openai-adapter.js';
import type { AnthropicAdapterConfig } from './anthropic-adapter.js';
import type { ProviderAdapter } from './types.js';
import { OpenAIAdapter } from './openai-adapter.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { getModelMaxOutputTokens, resolveOpenAiRequestTimeoutMs } from '../config/model-capabilities.js';
import { resolveActiveModelName } from '../config/parse-model-names.js';
import { resolveProviderApiKey } from '../config/resolve-api-key.js';
import { parseReasoningEffortLevels } from './reasoning-effort.js';
import { resolveProviderProtocol } from './provider-protocol.js';

function sharedAdapterFields(provider: ProviderConfig): {
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
  temperature?: number;
  maxTokens: number;
  topP?: number;
  supportsVision: boolean;
  timeout?: number;
  requestHeaders?: Record<string, string>;
  reasoningEffortLevels?: string[];
} {
  const activeModel = resolveActiveModelName(provider);
  const maxTokens = provider.parameters.maxTokens ?? getModelMaxOutputTokens(activeModel);
  const rt = resolveOpenAiRequestTimeoutMs(provider);
  const apiKey = resolveProviderApiKey(provider).apiKey || provider.apiKey;
  const reasoningEffortLevels = parseReasoningEffortLevels(provider.reasoningEffort);
  return {
    name: provider.id,
    apiKey,
    baseURL: provider.apiUrl,
    model: activeModel,
    temperature: provider.parameters.temperature,
    maxTokens,
    topP: provider.parameters.topP,
    supportsVision: provider.supportsVision ?? true,
    ...(rt !== undefined ? { timeout: rt } : {}),
    ...(provider.headers && Object.keys(provider.headers).length > 0
      ? { requestHeaders: { ...provider.headers } }
      : {}),
    ...(reasoningEffortLevels.length > 0 ? { reasoningEffortLevels } : {}),
  };
}

/** 将 data/config.json 中的 provider 条目转为 OpenAIAdapter 构造参数。 */
export function openAiAdapterConfigFromProvider(provider: ProviderConfig): OpenAIAdapterConfig {
  const apiMode = provider.apiMode ?? provider.parameters.apiMode;
  return {
    ...sharedAdapterFields(provider),
    ...(apiMode === 'responses' || apiMode === 'chat_completions' ? { apiMode } : {}),
  };
}

/** 将 data/config.json 中的 provider 条目转为 AnthropicAdapter 构造参数。 */
export function anthropicAdapterConfigFromProvider(provider: ProviderConfig): AnthropicAdapterConfig {
  return sharedAdapterFields(provider);
}

/** 按 apiMode / apiUrl 选择 OpenAI 兼容或 Anthropic Messages 适配器。 */
export function createProviderAdapter(provider: ProviderConfig): ProviderAdapter {
  if (resolveProviderProtocol(provider) === 'anthropic_messages') {
    return new AnthropicAdapter(anthropicAdapterConfigFromProvider(provider));
  }
  return new OpenAIAdapter(openAiAdapterConfigFromProvider(provider));
}
