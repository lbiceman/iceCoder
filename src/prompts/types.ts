/**
 * 提示词系统类型定义。
 *
 * 分段式系统提示词架构：
 * - 静态部分（可缓存）：身份、规则、工具使用指南、风格
 * - 动态部分（每会话变化）：环境信息、记忆、语言偏好
 *
 * 这种分段设计的好处：
 * 1. 每个 section 职责单一，易于维护
 * 2. 静态前缀可利用 API 的 prompt cache，降低成本
 * 3. 动态部分可按需注入，不影响缓存命中率
 */

/**
 * 提示词段落 — 系统提示词的最小组成单元。
 */
export interface PromptSection {
  /** 段落唯一标识 */
  id: string;
  /** 段落标题（用于日志和调试） */
  title: string;
  /** 段落内容（Markdown 格式） */
  content: string;
  /** 是否为静态内容（可跨会话缓存） */
  isStatic: boolean;
  /** 排序优先级（数字越小越靠前） */
  priority: number;
  /** 是否启用（可动态开关） */
  enabled: boolean;
}

/**
 * 提示词组装配置。
 */
export interface PromptAssemblyConfig {
  /** 自定义系统提示词（如果提供，替换默认提示词） */
  customSystemPrompt?: string;
  /** 附加说明（项目公约、评测模式等）：进入 harness 动态层 `projectMarkdown`，不拼进静态 system */
  appendSystemPrompt?: string;
  /** 若设置，则经由 overlay 注入动态 `# Language`；默认聊天可不传，由用户消息决定语气 */
  language?: string;
  /** 环境信息 */
  environment?: EnvironmentInfo;
  /** 记忆内容（项目级 + 用户级） */
  memories?: string[];
  /** 用户偏好 */
  userPreferences?: Record<string, any>;
  /** 工具名称列表（用于生成工具使用指南） */
  toolNames?: string[];
}

/**
 * 运行环境 — 经 `harnessOverlay.environment` 注入首轮 `<system-context>`，不写入静态 system。
 */
export interface EnvironmentInfo {
  /** 工作目录 */
  workingDirectory: string;
  /** 操作系统平台 */
  platform: string;
  /** Shell 类型 */
  shell?: string;
  /** 操作系统版本 */
  osVersion?: string;
  /** 是否为 Git 仓库 */
  isGitRepo?: boolean;
  /** 当前日期 */
  currentDate: string;
  /** 模型名称 */
  modelName?: string;
}

/**
 * 用户上下文 — 作为第一条 user 消息注入到对话中。
 *
 * 将项目规范、编码规范等以 <system-reminder> 标签包裹，
 * 注入到消息列表最前面。
 */
export interface UserContext {
  [key: string]: string;
}

/**
 * 系统上下文 — 追加到系统提示词末尾。
 *
 * 包含 git 状态等实时信息。
 */
export interface SystemContext {
  [key: string]: string;
}

/**
 * 不拼入静态 system、而交给 Harness 动态上下文的切片（首轮 &lt;system-context&gt;），
 * 避免日期/语言导致前缀缓存失效，并与 Execution 段落职责分离。
 */
export interface HarnessPromptOverlay {
  environment?: Record<string, string>;
  /** 示例："中文"；注入为简短的 Language 段 */
  language?: string;
  /** 如 .iceCoder/memory.md */
  projectMarkdown?: string;
}

/**
 * `harnessOverlayToContextFields` 的返回值；键与 Harness `ContextAssemblyConfig` 子集对齐。
 * 定义在本模块可避免 prompts ↔ harness 类型循环依赖。
 */
export interface HarnessDynamicContextSlice {
  environment?: Record<string, string>;
  language?: string;
  userContext?: Record<string, string>;
}

export interface AssembledPrompt {
  /** 系统提示词（分段数组） */
  systemPromptSections: PromptSection[];
  /** 系统提示词（拼接后的完整字符串 — 仅为稳定前缀，不含环境与语言段落） */
  systemPrompt: string;
  /** 动态层：环境与语言、项目 Markdown；由入口绑定到 Harness.context */
  harnessOverlay?: HarnessPromptOverlay;
  /** 用户上下文 */
  userContext?: UserContext;
  /** 系统上下文 */
  systemContext?: SystemContext;
}
