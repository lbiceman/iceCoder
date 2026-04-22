/**
 * 上下文组装器 — 负责"喂什么"给模型。
 *
 * 参考 Claude Code 的提示词拼接流程（prompt-assembly-flow）：
 * 1. 系统提示词（静态规则 + 动态环境/记忆），静态/动态分界支持缓存
 * 2. 用户上下文（以 <system-reminder> 注入到消息列表）
 * 3. 系统上下文（Git 状态等追加到系统提示词末尾）
 * 4. 工具定义
 *
 * 职责：
 * - system prompt 拼装（静态部分 memoize，动态部分每次重算）
 * - 用户上下文注入（CLAUDE.md/MEMORY.md 内容 + 当前日期）
 * - 系统上下文注入（Git 状态等实时信息）
 * - 消息规范化（合并连续 user、清理孤立消息、去重 tool_use ID）
 * - 工具定义组装
 */

import type { UnifiedMessage, ToolDefinition } from '../llm/types.js';
import type { ContextAssemblyConfig } from './types.js';

/**
 * ContextAssembler 将各种上下文源组装成发送给 LLM 的消息序列。
 */
export class ContextAssembler {
  private config: ContextAssemblyConfig;
  /** 静态系统提示词缓存（直到 invalidateCache 被调用） */
  private staticPromptCache: string | null = null;

  constructor(config: ContextAssemblyConfig) {
    this.config = config;
  }

  /**
   * 构建系统提示词，分为静态部分（可缓存）和动态部分（每次重算）。
   *
   * 参考 Claude Code 的 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 分界：
   * 静态前缀跨会话缓存，动态后缀每次重算。
   */
  buildSystemPrompt(): string {
    const staticPart = this.buildStaticPrompt();
    const dynamicPart = this.buildDynamicPrompt();
    return dynamicPart ? `${staticPart}\n\n${dynamicPart}` : staticPart;
  }

  /**
   * 静态部分：身份、规则、工具指南 — 可跨会话缓存。
   */
  private buildStaticPrompt(): string {
    if (this.staticPromptCache) return this.staticPromptCache;
    this.staticPromptCache = this.config.systemPrompt;
    return this.staticPromptCache;
  }

  /**
   * 动态部分：环境信息、记忆、用户偏好 — 每会话变化。
   */
  private buildDynamicPrompt(): string {
    const parts: string[] = [];

    // 环境信息
    if (this.config.environment && Object.keys(this.config.environment).length > 0) {
      const envLines = Object.entries(this.config.environment)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join('\n');
      parts.push(`# 环境信息\n${envLines}`);
    }

    // 持久化记忆提示词
    if (this.config.memoryPrompt) {
      parts.push(this.config.memoryPrompt);
    }

    // 额外记忆片段（向后兼容）
    if (this.config.memories && this.config.memories.length > 0) {
      parts.push(`# 相关记忆\n${this.config.memories.join('\n')}`);
    }

    // 用户偏好
    if (this.config.userPreferences && Object.keys(this.config.userPreferences).length > 0) {
      const prefLines = Object.entries(this.config.userPreferences)
        .map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`)
        .join('\n');
      parts.push(`# 用户偏好\n${prefLines}`);
    }

    // 系统上下文（Git 状态等实时信息）
    if (this.config.systemContext && Object.keys(this.config.systemContext).length > 0) {
      const ctxLines = Object.entries(this.config.systemContext)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      parts.push(ctxLines);
    }

    // 工具结果清理提醒
    parts.push(`# 工具结果管理\n旧的工具调用结果可能会被自动清理以节省上下文空间。请在获取重要信息后及时记录关键内容，因为工具结果可能在后续对话中不再可用。`);

    return parts.join('\n\n');
  }

  /**
   * 组装初始消息序列：system prompt + 用户上下文 + user message。
   */
  assembleInitialMessages(userMessage: string): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];

    const systemPrompt = this.buildSystemPrompt();
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // 注入用户上下文
    const userContextMsg = this.buildUserContextMessage();
    if (userContextMsg) {
      messages.push({ role: 'user', content: userContextMsg });
    }

    messages.push({ role: 'user', content: userMessage });

    return messages;
  }

  /**
   * 构建用户上下文消息。
   *
   * 参考 Claude Code 的 getUserContext() + prependUserContext()：
   * 将项目规范、当前日期、自定义上下文以 <system-reminder> 标签包裹。
   */
  private buildUserContextMessage(): string | null {
    const sections: string[] = [];

    // 自定义用户上下文（CLAUDE.md 等）
    if (this.config.userContext && Object.keys(this.config.userContext).length > 0) {
      for (const [key, value] of Object.entries(this.config.userContext)) {
        sections.push(`# ${key}\n${value}`);
      }
    }

    // 当前日期
    const now = new Date();
    sections.push(`# currentDate\n今天是 ${now.toISOString().split('T')[0]}。`);

    if (sections.length === 0) return null;

    return `<system-reminder>
以下上下文信息可能与你的任务相关，也可能无关。
不要主动回应这些上下文，除非它与当前任务高度相关。

${sections.join('\n\n')}
</system-reminder>`;
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
    // 如果更新了 systemPrompt，清除静态缓存
    if (partial.systemPrompt !== undefined) {
      this.staticPromptCache = null;
    }
  }

  /**
   * 清除静态提示词缓存（用于 /compact 或 /clear 后重建）。
   */
  invalidateCache(): void {
    this.staticPromptCache = null;
  }
}

// ─── 消息规范化工具函数 ───

/**
 * 规范化消息列表，准备发送给 API。
 *
 * 参考 Claude Code 的 normalizeMessagesForAPI()：
 * 1. 合并连续的 user 消息（API 不允许连续同角色消息）
 * 2. 去重 tool_use ID（防止重复 ID 导致 API 报错）
 * 3. 清理孤立的 assistant 消息（只有 thinking 没有内容或工具调用）
 * 4. 过滤空内容消息
 */
export function normalizeMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
  const result: UnifiedMessage[] = [];
  const seenToolCallIds = new Set<string>();

  // 第一遍：收集所有 assistant 消息中需要的 tool_call_id
  const requiredToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        requiredToolCallIds.add(tc.id);
      }
    }
  }

  for (let i = 0; i < messages.length; i++) {
    let msg = messages[i];

    // 跳过空内容消息（system 除外），但保留被 tool_call 依赖的 tool 消息
    if (msg.role !== 'system' && !msg.content && !msg.toolCalls?.length) {
      // 兜底：如果是 tool 消息且其 toolCallId 被某个 assistant 依赖，不能跳过
      if (msg.role === 'tool' && msg.toolCallId && requiredToolCallIds.has(msg.toolCallId)) {
        // 空内容的 tool 消息也必须保留，补一个占位内容
        msg = { ...msg, content: '[empty]' };
      } else {
        continue;
      }
    }

    // 去重 tool_use ID
    if (msg.toolCalls) {
      const dedupedCalls = msg.toolCalls.filter(tc => {
        if (seenToolCallIds.has(tc.id)) return false;
        seenToolCallIds.add(tc.id);
        return true;
      });
      if (dedupedCalls.length !== msg.toolCalls.length) {
        msg = { ...msg, toolCalls: dedupedCalls };
      }
    }

    // 合并连续 user 消息
    const prev = result[result.length - 1];
    if (
      msg.role === 'user'
      && prev?.role === 'user'
      && typeof msg.content === 'string'
      && typeof prev.content === 'string'
    ) {
      result[result.length - 1] = {
        ...prev,
        content: `${prev.content}\n\n${msg.content}`,
      };
      continue;
    }

    result.push(msg);
  }

  // 第二遍：兜底校验 — 确保每个 assistant(tool_calls) 后面都有对应的 tool 消息
  return ensureToolCallPairing(result);
}

/**
 * 兜底校验：确保消息列表中每个 assistant 的 tool_call 都有对应的 tool 消息。
 *
 * OpenAI API 要求：assistant 消息中的每个 tool_call_id 必须有一条
 * role=tool 的消息与之对应，否则返回 400 错误。
 *
 * 此函数在消息列表最终发送前做最后一道防线：
 * 1. 收集所有 assistant 消息中的 tool_call_id
 * 2. 收集所有 tool 消息中的 toolCallId
 * 3. 为缺失的 tool_call_id 补齐占位 tool 消息
 * 4. 移除没有对应 tool_call 的孤立 tool 消息
 */
export function ensureToolCallPairing(messages: UnifiedMessage[]): UnifiedMessage[] {
  // 收集所有 assistant 的 tool_call_id 及其位置
  const toolCallIdToAssistantIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        toolCallIdToAssistantIdx.set(tc.id, i);
      }
    }
  }

  // 如果没有 tool_calls，直接返回
  if (toolCallIdToAssistantIdx.size === 0) return messages;

  // 收集已有的 tool 消息的 toolCallId
  const existingToolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId) {
      existingToolResultIds.add(msg.toolCallId);
    }
  }

  // 找出缺失的 tool_call_id
  const missingIds: { id: string; assistantIdx: number }[] = [];
  for (const [id, idx] of toolCallIdToAssistantIdx) {
    if (!existingToolResultIds.has(id)) {
      missingIds.push({ id, assistantIdx: idx });
    }
  }

  // 找出孤立的 tool 消息（没有对应的 tool_call）
  const orphanedToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId && !toolCallIdToAssistantIdx.has(msg.toolCallId)) {
      orphanedToolCallIds.add(msg.toolCallId);
    }
  }

  // 如果没有缺失也没有孤立，直接返回
  if (missingIds.length === 0 && orphanedToolCallIds.size === 0) return messages;

  // 构建修复后的消息列表
  const result: UnifiedMessage[] = [];

  // 按 assistantIdx 分组缺失的 id，方便在正确位置插入
  const missingByAssistant = new Map<number, string[]>();
  for (const { id, assistantIdx } of missingIds) {
    if (!missingByAssistant.has(assistantIdx)) {
      missingByAssistant.set(assistantIdx, []);
    }
    missingByAssistant.get(assistantIdx)!.push(id);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // 跳过孤立的 tool 消息
    if (msg.role === 'tool' && msg.toolCallId && orphanedToolCallIds.has(msg.toolCallId)) {
      continue;
    }

    result.push(msg);

    // 在 assistant(tool_calls) 消息后面，找到该 assistant 对应的最后一条 tool 消息后插入缺失的
    if (msg.role === 'assistant' && missingByAssistant.has(i)) {
      // 先把后续已有的 tool 消息加入
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        if (!(messages[j].toolCallId && orphanedToolCallIds.has(messages[j].toolCallId!))) {
          result.push(messages[j]);
        }
        j++;
      }
      // 补齐缺失的 tool 消息
      for (const missingId of missingByAssistant.get(i)!) {
        result.push({
          role: 'tool',
          content: '[工具结果丢失 — 执行可能被中断或结果未正确记录]',
          toolCallId: missingId,
        });
      }
      // 跳过已处理的 tool 消息
      i = j - 1;
    }
  }

  return result;
}
