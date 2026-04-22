/**
 * 上下文压缩器 — 五层递进策略。
 *
 * 参考 Claude Code 的 services/compact/ 四层压缩，本项目实现五层：
 * 1. snip — 裁剪历史中的冗余段落（重复的 system-reminder、context-summary）
 * 2. microcompact — 对旧工具调用只保留名称+结果状态，删除参数细节和完整输出
 * 3. toolResultTrim — 裁剪超长的工具结果
 * 4. structuralExtract — 从被删消息中提取结构化摘要（不调 LLM）
 * 5. llmSummarize — 用 LLM 对被删消息生成摘要（可选）
 *
 * 阈值判断使用估算 token 数，区分中英文字符。
 * 压缩时保证消息对完整性：不会孤立 assistant 的 tool_calls 或 tool 结果。
 */

import type { UnifiedMessage } from '../llm/types.js';
import type { ChatFunction } from './types.js';

/**
 * 压缩配置。
 */
export interface CompactionConfig {
  /** 触发压缩的消息数量阈值（向后兼容） */
  threshold: number;
  /** 触发压缩的估算 token 阈值（优先于 threshold） */
  tokenThreshold?: number;
  /** 压缩后保留的最近消息数 */
  keepRecent: number;
  /** 单个工具结果的最大字符数 */
  maxToolResultLength: number;
  /** 是否启用 LLM 摘要（需要在 compact 时传入 chatFn） */
  enableLLMSummary?: boolean;
}

const DEFAULT_CONFIG: CompactionConfig = {
  threshold: 40,
  tokenThreshold: 80000,
  keepRecent: 10,
  maxToolResultLength: 3000,
  enableLLMSummary: false,
};

/**
 * 估算消息列表的 token 数。
 * 区分中英文：中文字符约 1 token/字，英文约 0.25 token/字。
 */
export function estimateTokens(messages: UnifiedMessage[]): number {
  let tokens = 0;
  for (const msg of messages) {
    tokens += estimateStringTokens(typeof msg.content === 'string' ? msg.content : '');
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.text) tokens += estimateStringTokens(block.text);
      }
    }
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        tokens += estimateStringTokens(tc.name + JSON.stringify(tc.arguments));
      }
    }
    tokens += 4; // 每条消息的 role/结构开销
  }
  return tokens;
}

/** 估算单个字符串的 token 数 */
function estimateStringTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x4E00 && code <= 0x9FFF) {
      tokens += 1; // CJK 字符约 1 token/字
    } else {
      tokens += 0.25; // 英文约 4 字符/token
    }
  }
  return Math.ceil(tokens);
}

/**
 * ContextCompactor 管理对话历史的压缩，防止 token 溢出。
 */
export class ContextCompactor {
  private config: CompactionConfig;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检查是否需要压缩。
   */
  needsCompaction(messages: UnifiedMessage[]): boolean {
    if (this.config.tokenThreshold) {
      return estimateTokens(messages) > this.config.tokenThreshold;
    }
    return messages.length > this.config.threshold;
  }

  /**
   * 获取当前消息的估算 token 数（供外部查询）。
   */
  getEstimatedTokens(messages: UnifiedMessage[]): number {
    return estimateTokens(messages);
  }

  /**
   * 执行五层递进压缩。
   */
  async compact(
    messages: UnifiedMessage[],
    chatFn?: ChatFunction,
  ): Promise<UnifiedMessage[]> {
    // 第一层：snip — 裁剪冗余段落
    let compacted = this.snip(messages);
    if (!this.needsCompaction(compacted)) return compacted;

    // 第二层：microcompact — 压缩旧工具调用细节
    compacted = this.microcompact(compacted);
    if (!this.needsCompaction(compacted)) return compacted;

    // 第三层：裁剪工具结果
    compacted = this.trimToolResults(compacted);
    if (!this.needsCompaction(compacted)) return compacted;

    // 分离消息
    const { systemMessages, droppedMessages, recentMessages } =
      this.splitMessages(compacted);

    if (droppedMessages.length === 0) return compacted;

    // 第四层：结构化摘要
    const structuralSummary = this.extractStructuralSummary(droppedMessages);

    // 第五层：LLM 精炼
    let finalSummary: string;
    if (this.config.enableLLMSummary && chatFn) {
      finalSummary = await this.llmSummarize(structuralSummary, droppedMessages, chatFn);
    } else {
      finalSummary = structuralSummary;
    }

    return [
      ...systemMessages,
      { role: 'user' as const, content: `<context-summary>\n${finalSummary}\n</context-summary>` },
      ...recentMessages,
    ];
  }

  /**
   * 第一层：Snip — 裁剪历史中的冗余段落。
   *
   * - 删除重复的 <system-reminder>（只保留最后一个）
   * - 删除旧的 <context-summary>（被新的替代）
   * - 删除空内容的 assistant 消息
   */
  private snip(messages: UnifiedMessage[]): UnifiedMessage[] {
    let lastReminderIdx = -1;
    let lastSummaryIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const content = typeof messages[i].content === 'string' ? messages[i].content as string : '';
      if (lastReminderIdx === -1 && content.startsWith('<system-reminder>')) lastReminderIdx = i;
      if (lastSummaryIdx === -1 && content.startsWith('<context-summary>')) lastSummaryIdx = i;
    }

    return messages.filter((msg, idx) => {
      const content = typeof msg.content === 'string' ? msg.content as string : '';
      if (content.startsWith('<system-reminder>') && idx !== lastReminderIdx) return false;
      if (content.startsWith('<context-summary>') && idx !== lastSummaryIdx) return false;
      if (msg.role === 'assistant' && !msg.toolCalls?.length && !content.trim()) return false;
      return true;
    });
  }

  /**
   * 第二层：Microcompact — 压缩旧工具调用的细节。
   *
   * 对非最近 N 轮的工具调用，只保留工具名和结果状态，
   * 删除参数细节和完整输出。
   */
  private microcompact(messages: UnifiedMessage[]): UnifiedMessage[] {
    const recentStart = Math.max(0, messages.length - this.config.keepRecent);

    return messages.map((msg, idx) => {
      if (idx >= recentStart) return msg;

      // 压缩旧的 assistant tool_calls
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const toolNames = msg.toolCalls.map(tc => tc.name).join(', ');
        return {
          ...msg,
          content: `[调用工具: ${toolNames}]`,
          toolCalls: msg.toolCalls.map(tc => ({ ...tc, arguments: {} })),
        };
      }

      // 压缩旧的 tool 结果
      if (msg.role === 'tool' && typeof msg.content === 'string') {
        const content = msg.content;
        const isError = content.startsWith('工具执行错误') || content.startsWith('工具调用被拒绝');
        const status = isError ? '失败' : '成功';
        const preview = content.substring(0, 50).replace(/\n/g, ' ');
        return { ...msg, content: `[${status}] ${preview}${content.length > 50 ? '...' : ''}` };
      }

      return msg;
    });
  }

  /**
   * 裁剪超长的工具结果。
   */
  trimToolResults(messages: UnifiedMessage[]): UnifiedMessage[] {
    return messages.map(msg => {
      if (msg.role === 'tool' && typeof msg.content === 'string') {
        if (msg.content.length > this.config.maxToolResultLength) {
          return {
            ...msg,
            content: msg.content.substring(0, this.config.maxToolResultLength) +
              `\n...[已截断，原始长度 ${msg.content.length} 字符]`,
          };
        }
      }
      return msg;
    });
  }

  /**
   * 将消息分为三部分：system、要删除的、要保留的。
   * 保证消息对完整性：如果切割点落在 assistant(tool_calls) 和 tool 结果之间，
   * 向前调整切割点，把整个工具交互对保留在一起。
   */
  private splitMessages(messages: UnifiedMessage[]): {
    systemMessages: UnifiedMessage[];
    droppedMessages: UnifiedMessage[];
    recentMessages: UnifiedMessage[];
  } {
    const systemMessages: UnifiedMessage[] = [];
    let contentStart = 0;

    // 提取 system 消息
    if (messages.length > 0 && messages[0].role === 'system') {
      systemMessages.push(messages[0]);
      contentStart = 1;
    }

    // 计算初始切割点
    let splitAt = Math.max(contentStart, messages.length - this.config.keepRecent);

    // 消息对完整性修正：
    // 如果 splitAt 处是 tool 消息，说明它的 assistant(tool_calls) 在前面，
    // 需要向前找到对应的 assistant 消息，把整个交互对放到 recent 中。
    while (splitAt > contentStart && messages[splitAt]?.role === 'tool') {
      splitAt--;
    }

    // 如果 splitAt 处是 assistant 且有 toolCalls，它的 tool 结果在后面，
    // 也需要一起保留，所以不动 splitAt（tool 结果已经在 recent 中了）。
    // 但如果 splitAt-1 是 assistant 且有 toolCalls，说明我们刚好切在
    // assistant 和 tool 之间，需要把 assistant 也放到 recent 中。
    if (
      splitAt > contentStart
      && messages[splitAt - 1]?.role === 'assistant'
      && messages[splitAt - 1]?.toolCalls?.length
    ) {
      // 检查 splitAt 处是否是对应的 tool 结果
      if (messages[splitAt]?.role === 'tool') {
        splitAt--;
      }
    }

    return {
      systemMessages,
      droppedMessages: messages.slice(contentStart, splitAt),
      recentMessages: messages.slice(splitAt),
    };
  }

  /**
   * 第四层：结构化摘要提取。
   */
  private extractStructuralSummary(messages: UnifiedMessage[]): string {
    const lines: string[] = [];
    lines.push(`以下是之前 ${messages.length} 条对话的结构化摘要：`);

    for (const msg of messages) {
      if (msg.role === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : '[多模态内容]';
        if (content.startsWith('<system-reminder>') || content.startsWith('<context-summary>')) continue;
        const truncated = content.length > 100 ? content.substring(0, 100) + '...' : content;
        lines.push(`- 用户: ${truncated}`);
      } else if (msg.role === 'assistant') {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const toolNames = msg.toolCalls.map(tc => {
            const argsStr = JSON.stringify(tc.arguments);
            const truncatedArgs = argsStr.length > 80 ? argsStr.substring(0, 80) + '...' : argsStr;
            return `${tc.name}(${truncatedArgs})`;
          });
          lines.push(`- 助手调用工具: ${toolNames.join(', ')}`);
        } else {
          const content = typeof msg.content === 'string' ? msg.content : '';
          if (content) {
            const truncated = content.length > 100 ? content.substring(0, 100) + '...' : content;
            lines.push(`- 助手: ${truncated}`);
          }
        }
      } else if (msg.role === 'tool') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        const isError = content.startsWith('工具执行错误') || content.startsWith('工具调用被拒绝') || content.startsWith('[失败]');
        const status = isError ? '❌' : '✅';
        const truncated = content.length > 80 ? content.substring(0, 80) + '...' : content;
        lines.push(`  ${status} 结果: ${truncated}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 第五层：LLM 精炼摘要。
   */
  private async llmSummarize(
    structuralSummary: string,
    _droppedMessages: UnifiedMessage[],
    chatFn: ChatFunction,
  ): Promise<string> {
    try {
      const summarizeMessages: UnifiedMessage[] = [
        {
          role: 'system',
          content: '你是一个上下文压缩助手。将以下对话摘要精炼为更简洁的版本，保留：1) 用户的核心意图 2) 关键的工具调用及其结果 3) 重要的决策点和发现。删除重复信息和不重要的细节。用中文输出，控制在 500 字以内。',
        },
        {
          role: 'user',
          content: structuralSummary,
        },
      ];

      const response = await chatFn(summarizeMessages, { tools: [] });
      if (response.content && response.content.length > 0) {
        return response.content;
      }
    } catch {
      // LLM 摘要失败，回退到结构化摘要
    }

    return structuralSummary;
  }
}
