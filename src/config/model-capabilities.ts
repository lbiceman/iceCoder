/**
 * 模型能力推断（上下文窗口、单次输出上限、请求超时）。
 *
 * 这些纯函数原先内联在 `web/routes/config.ts`，导致核心层（llm / harness）
 * 反向依赖 web 路由层。抽到 config 域作为单一来源，web 路由对外仍可从
 * `web/routes/config.ts` 重新导出以保持向后兼容。
 */

import type { ProviderConfig } from '../web/types.js';

/** Agent 运行时未配置 maxTokens 时的单次输出上限（未知/新模型兜底） */
export const DEFAULT_AGENT_MAX_OUTPUT_TOKENS = 16384;

/**
 * 根据模型名称返回最大上下文长度（token 数）。
 * 已知模型返回精确值，未知模型根据名称模式推断。
 */
export function getModelMaxContext(modelName: string): number {
  const name = modelName.toLowerCase();

  // DeepSeek 系列
  if (name.includes('deepseek-v4')) return 1000000;
  if (name.includes('deepseek')) return 131072;

  // OpenAI GPT-4o 系列
  if (name.includes('gpt-4o')) return 128000;
  if (name.includes('gpt-4-turbo')) return 128000;
  if (name.includes('gpt-4')) return 8192;
  if (name.includes('gpt-3.5-turbo-16k')) return 16384;
  if (name.includes('gpt-3.5')) return 4096;
  if (name.includes('o1') || name.includes('o3') || name.includes('o4')) return 200000;
  if (name.includes('openai.gpt-5.5') || name.includes('openai.gpt-5.4')) return 272000;

  // GLM 系列
  if (name.includes('glm-4')) return 128000;
  if (name.includes('glm')) return 128000;

  // Qwen 系列
  if (name.includes('qwen')) return 131072;

  // Llama 系列
  if (name.includes('llama-3')) return 128000;
  if (name.includes('llama')) return 8192;

  // Mistral 系列
  if (name.includes('mistral')) return 32768;
  if (name.includes('mixtral')) return 32768;

  // 默认保守估计
  return 8192;
}

/**
 * 根据模型名称返回单次最大输出 token 数。
 * 用户不填 maxTokens 时，系统自动推算。
 */
export function getModelMaxOutputTokens(modelName: string): number {
  const name = modelName.toLowerCase();

  // DeepSeek 系列
  if (name.includes('deepseek-v4')) return 16384;
  if (name.includes('deepseek')) return 16384;

  // OpenAI 系列
  if (name.includes('o1') || name.includes('o3') || name.includes('o4')) return 100000;
  if (name.includes('gpt-4o')) return 16384;
  if (name.includes('gpt-4-turbo')) return 4096;
  if (name.includes('gpt-4')) return 16384;
  if (name.includes('gpt-3.5')) return 4096;

  // GLM 系列
  if (name.includes('glm')) return 16384;

  // Qwen 系列
  if (name.includes('qwen')) return 16384;

  // MiniMax / MiMo 系列
  if (name.includes('minimax') || name.includes('mimo')) return 16384;

  // Llama 系列
  if (name.includes('llama')) return 4096;

  // Mistral 系列
  if (name.includes('mistral') || name.includes('mixtral')) return 4096;

  // 未知模型：Agent 场景需容纳整文件 write_file 等长 tool 参数
  return DEFAULT_AGENT_MAX_OUTPUT_TOKENS;
}

/**
 * 解析 OpenAI 兼容提供者的单次请求超时（毫秒）。
 * 优先级：provider.requestTimeoutMs → ICE_OPENAI_REQUEST_TIMEOUT_MS → undefined（由适配器默认 120s 处理）。
 */
export function resolveOpenAiRequestTimeoutMs(provider: ProviderConfig): number | undefined {
  if (
    typeof provider.requestTimeoutMs === 'number' &&
    Number.isFinite(provider.requestTimeoutMs) &&
    provider.requestTimeoutMs > 0
  ) {
    return Math.floor(provider.requestTimeoutMs);
  }
  const raw = process.env.ICE_OPENAI_REQUEST_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
