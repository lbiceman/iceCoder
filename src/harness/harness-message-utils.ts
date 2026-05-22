import type { UnifiedMessage } from '../llm/types.js';
import { hasExecutableSideSignal } from './task-state.js';

/**
 * 基于字符 bigram 的 Jaccard 相似度（零外部依赖，纯 CPU 计算）。
 * 用于检测用户新消息与上一轮 assistant 回复之间的主题关联度。
 */
export function bigramJaccard(a: string, b: string): number {
  if (!a || !b) return 0;
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) {
      set.add(s.substring(i, i + 2));
    }
    return set;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  let intersection = 0;
  for (const bg of setA) {
    if (setB.has(bg)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * 从消息列表中提取最近一条 assistant 的纯文本回复。
 */
export function getLastAssistantText(messages: UnifiedMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return '';
}

/**
 * 识别「非真人用户」的 user 前缀（运行时状态、会话笔记摘要、工具规划等）。
 * {@link getLatestRealUserText} 会跳过此类消息。
 */
export function isSystemInjectedUserContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('<system-context>')
    || trimmed.startsWith('<system-reminder>')
    || trimmed.startsWith('<session-notes>')
    || trimmed.startsWith('<context-summary>')
    || trimmed.startsWith('[System Runtime State]')
    || trimmed.startsWith('[System')
    || trimmed.startsWith('[Runtime Tool Planner]')
    || trimmed.startsWith('Please provide a final summary answer based on the tool call results above.')
    || trimmed.startsWith('Continue directly');
}

/** 倒序查找第一条未被 {@link isSystemInjectedUserContent} 排除的 user 文本。 */
export function getLatestRealUserText(messages: UnifiedMessage[], fallback = ''): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (isSystemInjectedUserContent(msg.content)) continue;
    return msg.content;
  }
  return fallback;
}

/** 是否已有 assistant 带 `toolCalls` 的轮次（任意位置）。 */
export function hasAssistantToolCallAttempt(messages: UnifiedMessage[]): boolean {
  return messages.some(m => m.role === 'assistant' && !!m.toolCalls?.length);
}

/**
 * 自最近一条真实 user 起，后方是否出现过 assistant `toolCalls`。
 * 用于判别「本条用户输入之后模型是否尝试过工具」。
 */
export function hasAssistantToolCallAfterLatestRealUser(messages: UnifiedMessage[]): boolean {
  let latestRealUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (isSystemInjectedUserContent(msg.content)) continue;
    latestRealUserIndex = i;
    break;
  }
  if (latestRealUserIndex < 0) return hasAssistantToolCallAttempt(messages);

  return messages
    .slice(latestRealUserIndex + 1)
    .some(m => m.role === 'assistant' && !!m.toolCalls?.length);
}

/**
 * 是否适合首轮注入 Runtime Tool Planner，并可能与执行计划同开。
 *
 * - 第一层：中英文子串判断是否像「要动工具的工程诉求」；
 * - 第二层：若以纯疑问措辞开头且无 edit 同义词（实现/新增/创建等），视为不可执行。
 */
export function isActionableToolRequest(text: string): boolean {
  const t = text.trim().toLowerCase();
  const rawTrim = text.trim();
  if (!t) return false;

  const isActionable = /修(复|好|改)|改一下|解决|处理|排查|看看为什么|优化|重构|实现|落地|执行|运行|测试|检查|读取|搜索|新增|创建|删除|生成|添加|提交|创建.*pr/i.test(t)
    || /\b(fix|debug|investigate|implement|modify|edit|update|refactor|search|read|create|delete|commit|check)\b/i.test(t)
    || /\b(run|execute)\s+\S+/i.test(t)
    || /\b(test|verify)\s+\S+|\S+\s+(tests?|verification)\b/i.test(t);
  if (!isActionable) return false;

  // 「分析一下…」等与英文 \b：JS 的词边界夹在汉字之间常为 false，需单独前缀或分隔符判别
  const questionOnlyCn = rawTrim.startsWith('分析一下')
    || rawTrim.startsWith('说明一下')
    || rawTrim.startsWith('解释一下')
    || rawTrim.startsWith('为什么')
    || rawTrim.startsWith('如何')
    || rawTrim.startsWith('怎么')
    || /^解释([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^说明([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^分析([\s\u3000，。、！？]|$)/.test(rawTrim);
  const questionOnly = (questionOnlyCn || /^(what|why|how)\b/i.test(t))
    && !hasExecutableSideSignal(text);
  return !questionOnly;
}

/** 子代理回灌的 tool 消息格式，供历史裁剪识别。 */
export function isSubAgentToolResult(msg: UnifiedMessage): msg is UnifiedMessage & { content: string } {
  return msg.role === 'tool'
    && typeof msg.content === 'string'
    && msg.content.startsWith('[SubAgent Result]');
}
