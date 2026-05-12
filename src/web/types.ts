/**
 * Web 服务器模块的类型定义。
 */

/**
 * LLM 提供者配置，存储在 data/config.json 中。
 */
export interface ProviderConfig {
  id: string;
  providerName: string;
  apiUrl: string;
  apiKey: string;
  modelName: string;
  /**
   * OpenAI 兼容适配器：单次 HTTP 请求超时（毫秒）。
   * 未设置时可用环境变量 ICE_OPENAI_REQUEST_TIMEOUT_MS；再高才回退 SDK 默认。
   */
  requestTimeoutMs?: number;
  parameters: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    chatTemplateKwargs?: Record<string, any>;
    [key: string]: any;
  };
  isDefault?: boolean;
}
