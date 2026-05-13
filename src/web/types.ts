/**
 * Web 服务器模块的类型定义。
 */

/**
 * LLM 提供者配置，存储在 data/config.json 中。
 * 前端 UI、REST、CLI、压缩器、WebSocket 均依赖此结构与真实 JSON 一致；新增顶层字段时请同步 `data/config.example.json`。
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
  supportsVision?: boolean;
  /** 会话宠物与压缩器参考的上下文窗口上限（token） */
  maxContextTokens?: number;
}

/** `data/config.json` 顶层结构（仅存 providers 数组；未来可扩展其他键） */
export interface IceCoderConfigFile {
  providers: ProviderConfig[];
}
