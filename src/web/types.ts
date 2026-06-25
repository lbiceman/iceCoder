/**
 * Web 服务器模块的类型定义。
 */

/**
 * LLM 提供者配置，存储在 data/config.json 中。
 * 前端 UI、REST、CLI、压缩器、WebSocket 均依赖此结构与真实 JSON 一致；新增顶层字段时请同步 `data/config.example.json`。
 */
export interface ProviderConfig {
  id: string;
  apiUrl: string;
  apiKey: string;
  modelName: string;
  /**
   * OpenAI 兼容 API 模式：`chat_completions`（默认）或 `responses`（Bedrock GPT-5.4/5.5 等）。
   * 也可在 `parameters.apiMode` 中设置。
   */
  apiMode?: 'chat_completions' | 'responses';
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
  /** 是否支持图片/视觉输入；未设置时默认为 `true` */
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
  /**
   * 为 `true` 时跳过 Harness 工具权限检查（deny/confirm/破坏性确认），直接执行工具。
   * 字段缺失或为 `false` 时走默认权限规则。
   */
  skipPermissionChecks?: boolean;
  /**
   * Shell 命令黑名单（字符串正则，不含首尾 `/`）。
   * 缺失时使用内置默认（rm -rf、format、shutdown 等）；空数组 `[]` 表示不启用黑名单。
   */
  shellBlacklist?: string[];
  /**
   * 写后读验收豁免目录前缀（相对工作区根），如 `.scratch`、`tmp/agent`。
   * 与工作区根目录 `.icecoder.json` 中同名字段合并。
   */
  verificationExemptDirs?: string[];
}
