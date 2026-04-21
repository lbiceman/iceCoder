/**
 * 上下文压缩器 — 负责"崩了怎么办"中的上下文截断。
 *
 * 职责：
 * - 防止 token 溢出
 * - 对话历史压缩（保留最近消息，摘要旧消息）
 * - 工具结果裁剪（超大输出截断）
 *
 * 压缩策略（从轻到重）：
 * 1. toolResultTrim — 裁剪超长的工具结果
 * 2. dropOldToolResults — 删除旧的工具调用/结果对
 * 3. summarize — 将旧对话折叠为摘要（需要 LLM）
 */

import type { UnifiedMessage } from '../llm/types.js';

/**
 * 压缩配置。
 */
export interface CompactionConfig {
  /** 触发压缩的消息数量阈值 */
  threshold: number;
  /** 压缩后保留的最近消息数 */
  keepRecent: number;
  /** 单个工具结果的最大字符数 */
  maxToolResultLength: number;
}

const DEFAULT_CONFIG: CompactionConfig = {
  threshold: 40,
  keepRecent: 10,
  maxToolResultLength: 3000,
};

/**
 * ContextCompactor 管理对话历史的压缩，防止 token 溢出。
 * 对应 Harness 文档中的"上下文截断（防止 token 溢出）"。
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
    return messages.length > this.config.threshold;
  }

  /**
   * 执行压缩：裁剪工具结果 + 删除旧的工具交互。
   * 保留 system prompt（第一条）和最近的 keepRecent 条消息。
   *
   * @param messages - 当前对话消息
   * @returns 压缩后的消息列表
   */
  compact(messages: UnifiedMessage[]): UnifiedMessage[] {
    if (messages.length <= this.config.threshold) {
      return messages;
    }

    // 1. 先裁剪所有工具结果
    let compacted = this.trimToolResults(messages);

    // 2. 如果还是太长，删除旧消息，保留 system + 最近的
    if (compacted.length > this.config.threshold) {
      compacted = this.dropOldMessages(compacted);
    }

    return compacted;
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
   * 删除旧消息，保留 system prompt 和最近的消息。
   * 在删除区域插入一条摘要消息。
   */
  dropOldMessages(messages: UnifiedMessage[]): UnifiedMessage[] {
    const result: UnifiedMessage[] = [];

    // 保留 system prompt（如果有）
    let startIdx = 0;
    if (messages.length > 0 && messages[0].role === 'system') {
      result.push(messages[0]);
      startIdx = 1;
    }

    // 计算要保留的最近消息
    const keepFrom = Math.max(startIdx, messages.length - this.config.keepRecent);
    const droppedCount = keepFrom - startIdx;

    if (droppedCount > 0) {
      // 插入压缩摘要
      result.push({
        role: 'user',
        content: `[上下文压缩：已省略 ${droppedCount} 条较早的对话消息。请基于最近的对话继续。]`,
      });
    }

    // 保留最近的消息
    for (let i = keepFrom; i < messages.length; i++) {
      result.push(messages[i]);
    }

    return result;
  }
}
