/**
 * 提示词组装器 — 将各段落组装成完整的系统提示词。
 *
 * 提示词拼接流程：
 *
 * 1. 收集所有段落（静态 + 动态）
 * 2. 按优先级排序
 * 3. 过滤掉未启用的段落
 * 4. 拼接成完整的系统提示词字符串
 * 5. 可选：注入用户上下文和系统上下文
 *
 * 当前使用单字符串形式（更简单，适合当前架构），
 * 但保留了分段设计，方便未来升级为数组形式（每个元素一个 cache block）。
 */

import type {
  PromptSection,
  PromptAssemblyConfig,
  AssembledPrompt,
  UserContext,
  SystemContext,
} from './types.js';
import {
  getDefaultSections,
  createEnvironmentSection,
  createLanguageSection,
  createMemorySection,
  createPreferencesSection,
} from './sections.js';

/**
 * 提示词组装器。
 *
 * 使用方式：
 * ```ts
 * const assembler = new PromptAssembler();
 * const result = assembler.assemble({
 *   language: '中文',
 *   environment: { workingDirectory: '/project', platform: 'darwin', currentDate: '2026-04-22' },
 *   memories: ['项目使用 TypeScript + Vite'],
 * });
 * console.log(result.systemPrompt);
 * ```
 */
export class PromptAssembler {
  private customSections: PromptSection[] = [];

  /**
   * 添加自定义段落。
   */
  addSection(section: PromptSection): void {
    this.customSections.push(section);
  }

  /**
   * 移除指定 ID 的段落。
   */
  removeSection(id: string): void {
    this.customSections = this.customSections.filter(s => s.id !== id);
  }

  /**
   * 组装完整的提示词。
   */
  assemble(config: PromptAssemblyConfig = {}): AssembledPrompt {
    // 如果提供了自定义系统提示词，直接使用
    if (config.customSystemPrompt) {
      const content = config.appendSystemPrompt
        ? `${config.customSystemPrompt}\n\n${config.appendSystemPrompt}`
        : config.customSystemPrompt;

      return {
        systemPromptSections: [{
          id: 'custom',
          title: '自定义提示词',
          content,
          isStatic: false,
          priority: 0,
          enabled: true,
        }],
        systemPrompt: content,
      };
    }

    // 收集所有段落
    const sections: PromptSection[] = [
      ...getDefaultSections(),
      ...this.customSections,
    ];

    // 添加动态段落
    if (config.environment) {
      sections.push(createEnvironmentSection(config.environment));
    }

    if (config.language) {
      sections.push(createLanguageSection(config.language));
    }

    if (config.memories && config.memories.length > 0) {
      sections.push(createMemorySection(config.memories));
    }

    if (config.userPreferences && Object.keys(config.userPreferences).length > 0) {
      sections.push(createPreferencesSection(config.userPreferences));
    }

    // 过滤 + 排序
    const enabledSections = sections
      .filter(s => s.enabled)
      .sort((a, b) => a.priority - b.priority);

    // 拼接
    let systemPrompt = enabledSections
      .map(s => s.content)
      .join('\n\n');

    // 追加内容
    if (config.appendSystemPrompt) {
      systemPrompt += `\n\n${config.appendSystemPrompt}`;
    }

    // 构建用户上下文
    const userContext = this.buildUserContext(config);

    // 构建系统上下文
    const systemContext = this.buildSystemContext(config);

    return {
      systemPromptSections: enabledSections,
      systemPrompt,
      userContext: Object.keys(userContext).length > 0 ? userContext : undefined,
      systemContext: Object.keys(systemContext).length > 0 ? systemContext : undefined,
    };
  }

  /**
   * 构建用户上下文。
   *
   * 将项目规范等以 key-value 形式返回，
   * 后续由 Harness 以 <system-reminder> 标签注入到消息列表。
   */
  private buildUserContext(config: PromptAssemblyConfig): UserContext {
    const context: UserContext = {};

    if (config.memories && config.memories.length > 0) {
      context.projectMemory = config.memories.join('\n\n');
    }

    if (config.environment?.currentDate) {
      context.currentDate = `今天是 ${config.environment.currentDate}。`;
    }

    return context;
  }

  /**
   * 构建系统上下文。
   *
   * 包含 git 状态等实时信息，追加到系统提示词末尾。
   */
  private buildSystemContext(_config: PromptAssemblyConfig): SystemContext {
    // 当前版本暂不注入 git 状态等，预留扩展点
    return {};
  }
}

/**
 * 将用户上下文格式化为 <system-reminder> 消息。
 *
 * 将用户上下文包裹在 <system-reminder> 标签中，
 * 作为第一条 user 消息注入到对话历史。
 */
export function formatUserContextMessage(userContext: UserContext): string {
  if (Object.keys(userContext).length === 0) return '';

  const sections = Object.entries(userContext)
    .map(([key, value]) => `# ${key}\n${value}`)
    .join('\n\n');

  return `<system-reminder>
以下上下文信息可能与你的任务相关，也可能无关。
不要主动回应这些上下文，除非它与当前任务高度相关。

${sections}
</system-reminder>`;
}

/**
 * 将系统上下文追加到系统提示词。
 */
export function appendSystemContext(
  systemPrompt: string,
  systemContext: SystemContext,
): string {
  if (Object.keys(systemContext).length === 0) return systemPrompt;

  const contextStr = Object.entries(systemContext)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');

  return `${systemPrompt}\n\n${contextStr}`;
}
