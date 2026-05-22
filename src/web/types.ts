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
  /**
   * 上下文窗口上限（token）；默认 provider 此值参与计算生效窗口（见 `readEffectiveContextWindowTokens`）
   * 并映射档位：≤128K→S，≤256K→M，≤512K→L，>512K→XL（`tierFromMaxContextTokens`）。
   */
  maxContextTokens?: number;
}

/** `data/config.json` 顶层结构 */
export interface IceCoderConfigFile {
  providers: ProviderConfig[];
  /**
   * 双模监管档位（Web 顶栏与配置页可改）。
   * `off` | `adaptive` | `strict`；未设置时由 supervisor-config.json 的 `mode` 兜底。
   */
  supervisorMode?: 'off' | 'adaptive' | 'strict';
}
