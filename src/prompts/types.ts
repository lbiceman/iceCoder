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
  /** 追加到系统提示词末尾的内容 */
  appendSystemPrompt?: string;
  /** 语言偏好（如 "中文"、"English"） */
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
 * 环境信息 — 注入到系统提示词中，让模型了解运行环境。
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
 * 组装后的完整提示词结构。
 */
export interface AssembledPrompt {
  /** 系统提示词（分段数组） */
  systemPromptSections: PromptSection[];
  /** 系统提示词（拼接后的完整字符串） */
  systemPrompt: string;
  /** 用户上下文 */
  userContext?: UserContext;
  /** 系统上下文 */
  systemContext?: SystemContext;
}
