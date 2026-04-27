/**
 * 统一的 token 估算器。
 *
 * 全项目共享一套估算逻辑，用于：
 * - 上下文压缩触发判断
 * - ProviderAdapter.countTokens() 的默认实现
 * - 记忆系统 sideQuery 的 countTokens
 *
 * 估算策略：
 * - CJK 字符（中日韩）：约 1 token/字
 * - 英文/ASCII：约 0.25 token/字（4 字符/token）
 * - 每条消息固定开销 4 token（role 标记 + 结构分隔符）
 *
 * 精度：对混合中英文内容误差约 ±20%，足够用于阈值判断。
 * 如需精确计数，应使用 API 返回的 usage 字段。
 */

import type { UnifiedMessage } from './types.js';

/**
 * 估算单个字符串的 token 数。
 *
 * 区分 CJK 和 ASCII 字符，比简单的 `length / 4` 在中文场景下准确 3-4 倍。
 */
export function estimateStringTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // CJK 统一表意文字基本区 + 扩展 A/B 常用范围
    if (code >= 0x4E00 && code <= 0x9FFF) {
      tokens += 1;
    } else if (code >= 0x3400 && code <= 0x4DBF) {
      // CJK 扩展 A
      tokens += 1;
    } else if (code >= 0x3000 && code <= 0x303F) {
      // CJK 标点符号（。、！？等）
      tokens += 1;
    } else if (code >= 0xFF00 && code <= 0xFFEF) {
      // 全角字符
      tokens += 1;
    } else if (code >= 0xAC00 && code <= 0xD7AF) {
      // 韩文音节
      tokens += 1;
    } else if (code >= 0x3040 && code <= 0x30FF) {
      // 日文平假名 + 片假名
      tokens += 1;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/** 每条消息的固定结构开销（role 标记 + 分隔符） */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * 估算消息列表的总 token 数。
 *
 * 包含：文本内容 + 工具调用参数 + 每条消息的结构开销。
 */
export function estimateMessagesTokens(messages: UnifiedMessage[]): number {
  let tokens = 0;
  for (const msg of messages) {
    // 文本内容
    if (typeof msg.content === 'string') {
      tokens += estimateStringTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.text) tokens += estimateStringTokens(block.text);
      }
    }
    // 工具调用
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        tokens += estimateStringTokens(tc.name + JSON.stringify(tc.arguments));
      }
    }
    // 消息结构开销
    tokens += MESSAGE_OVERHEAD_TOKENS;
  }
  return tokens;
}
