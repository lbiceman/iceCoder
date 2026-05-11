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
  parameters: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    chatTemplateKwargs?: Record<string, any>;
    [key: string]: any;
  };
  isDefault?: boolean;
}
