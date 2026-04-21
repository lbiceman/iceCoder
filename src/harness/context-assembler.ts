/**
 * 上下文组装器 — 负责"喂什么"给模型。
 *
 * 职责：
 * - system prompt 拼装
 * - 记忆注入（用户偏好、历史反馈）
 * - 环境信息注入（OS、当前目录）
 * - 工具定义组装
 */

import type { UnifiedMessage, ToolDefinition } from '../llm/types.js';
import type { ContextAssemblyConfig } from './types.js';

/**
 * ContextAssembler 将各种上下文源组装成发送给 LLM 的消息序列。
 * 对应 Harness 文档中的"喂什么（上下文组装）"。
 */
export class ContextAssembler {
  private config: ContextAssemblyConfig;

  constructor(config: ContextAssemblyConfig) {
    this.config = config;
  }

  /**
   * 构建系统提示词，合并基础 prompt、环境信息和记忆。
   */
  buildSystemPrompt(): string {
    const parts: string[] = [this.config.systemPrompt];

    // 注入环境信息
    if (this.config.environment && Object.keys(this.config.environment).length > 0) {
      const envLines = Object.entries(this.config.environment)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n');
      parts.push(`\n环境信息:\n${envLines}`);
    }

    // 注入记忆
    if (this.config.memories && this.config.memories.length > 0) {
      parts.push(`\n相关记忆:\n${this.config.memories.join('\n')}`);
    }

    // 注入用户偏好
    if (this.config.userPreferences && Object.keys(this.config.userPreferences).length > 0) {
      const prefLines = Object.entries(this.config.userPreferences)
        .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
        .join('\n');
      parts.push(`\n用户偏好:\n${prefLines}`);
    }

    return parts.join('\n');
  }

  /**
   * 组装初始消息序列：system prompt + user message。
   */
  assembleInitialMessages(userMessage: string): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];

    const systemPrompt = this.buildSystemPrompt();
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    messages.push({ role: 'user', content: userMessage });

    return messages;
  }

  /**
   * 获取可用工具定义。
   */
  getTools(): ToolDefinition[] {
    return this.config.tools;
  }

  /**
   * 更新上下文配置（用于运行时动态调整）。
   */
  updateConfig(partial: Partial<ContextAssemblyConfig>): void {
    Object.assign(this.config, partial);
  }
}
