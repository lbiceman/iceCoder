/**
 * 上下文组装器 — 负责"喂什么"给模型。
 *
 * 提示词拼接流程：
 * 1. 系统提示词（纯静态规则，跨轮次不变 → 最大化前缀缓存命中）
 * 2. 动态上下文（环境/记忆/偏好，作为独立 user 消息注入 → 不污染 system prompt 前缀）
 * 3. 工具定义（跨轮次不变 → 缓存友好）
 *
 * Prompt Caching 优化原则：
 * - system prompt 内容跨轮次完全一致 → DeepSeek/OpenAI 自动前缀缓存命中
 * - 动态内容（记忆、日期等）放在 system prompt 之后的独立消息中
 * - 已发送的消息内容不做就地修改（由 harness 在发送副本上裁剪）
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
  /** 动态上下文缓存（内容变化时才重算） */
  private dynamicContextCache: string | null = null;
  private dynamicContextHash: string = '';

  constructor(config: ContextAssemblyConfig) {
    this.config = config;
  }

  /**
   * 构建系统提示词 — 仅包含静态内容。
   *
   * Prompt Caching 关键：system prompt 跨轮次完全一致，
   * DeepSeek/OpenAI 的自动前缀缓存才能命中。
   * 动态内容（记忆、环境等）通过 buildDynamicContextMessage() 独立注入。
   */
  buildSystemPrompt(): string {
    return this.buildStaticPrompt();
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
   * 构建动态上下文消息（环境信息、记忆、用户偏好等）。
   *
   * 作为独立的 user 消息注入到 system prompt 之后，
   * 不污染 system prompt 的前缀缓存。
   * 返回 null 表示没有有意义的动态内容。
   */
  buildDynamicContextMessage(): string | null {
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

    // 自定义用户上下文（XXX.md等）
    if (this.config.userContext && Object.keys(this.config.userContext).length > 0) {
      for (const [key, value] of Object.entries(this.config.userContext)) {
        parts.push(`# ${key}\n${value}`);
      }
    }

    // 只有在有实质性动态内容时才生成上下文消息
    if (parts.length === 0) return null;

    // 追加日期和工具提醒（仅在有其他动态内容时才附加）
    const now = new Date();
    parts.push(`# currentDate\n今天是 ${now.toISOString().split('T')[0]}。`);
    parts.push(`# 工具结果管理\n旧的工具调用结果可能会被自动清理以节省上下文空间。请在获取重要信息后及时记录关键内容，因为工具结果可能在后续对话中不再可用。`);

    return `<system-context>\n${parts.join('\n\n')}\n</system-context>`;
  }

  /**
   * 组装初始消息序列：system prompt + 动态上下文 + user message。
   *
   * 结构：
   * - 有动态上下文时: [system, user(<system-context> + 用户输入)]
   * - 无动态上下文时: [system, user(用户输入)]
   *
   * 动态上下文和用户输入合并为一条 user 消息，避免连续 user 消息问题。
   * 动态上下文在会话内不变，所以合并后的消息前缀仍然稳定 → 缓存友好。
   */
  assembleInitialMessages(userMessage: string): UnifiedMessage[] {
    const messages: UnifiedMessage[] = [];

    const systemPrompt = this.buildSystemPrompt();
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // 动态上下文和用户输入合并为一条 user 消息
    const dynamicContext = this.buildDynamicContextMessage();
    if (dynamicContext) {
      messages.push({ role: 'user', content: `${dynamicContext}\n\n${userMessage}` });
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

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
    this.dynamicContextCache = null;
    this.dynamicContextHash = '';
  }
}

// ─── 消息规范化工具函数 ───

/**
 * 规范化消息列表，准备发送给 API。
 *
 * 处理逻辑：
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
