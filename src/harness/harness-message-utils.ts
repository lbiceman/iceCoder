import type { ContentBlock, UnifiedMessage } from '../llm/types.js';
import { hasExecutableSideSignal } from './task-state.js';

/** 从 user 消息 content 提取纯文本（含多模态消息中的 text 块）。 */
export function extractUserMessageText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

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
 * 识别「非真人用户」的 user 前缀。
 * 压缩切分、目标锚点、记忆召回和任务切换共用这一份规则。
 * 运行时诊断（失败证据、自检、验收摘要）也算注入：它们一旦被当成新用户任务，
 * 模型会丢掉当前目标，再把自己刚打出的工具调用解释成新任务。
 */
const SYSTEM_INJECTED_USER_PREFIXES = [
  '<system-context>',
  '<system-reminder>',
  '<session-notes>',
  '<context-summary>',
  '<compact_boundary',
  '<recent-dialogue-focus',
  '<runtime-recovery-context>',
  '<recent-file-contents>',
  '<resume-checkpoint>',
  '[Background Task Status]',
  '[Background Agents]',
  '[System Runtime State]',
  '[Workspace Anchor]',
  '[System / Workspace Change]',
  '[System',
  '[Runtime Tool Planner]',
  '[Runtime Self-Review]',
  '[Failure Evidence',
  '[Verification digest]',
  '[Build digest]',
  '[ToolGate]',
  '[Tool skipped]',
  '[Harness /',
  '[Contract]',
  '[TaskGraph]',
  '[Agent Result]',
  'Please provide a final summary answer based on the tool call results above.',
  'Continue directly',
] as const;

export function isSystemInjectedUserContent(content: string): boolean {
  const trimmed = content.trim();
  return SYSTEM_INJECTED_USER_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

/** 首轮把动态上下文和用户输入合成一条 user 消息时，两者之间的分隔。 */
export const DYNAMIC_CONTEXT_USER_SEPARATOR = "\n\n---\n## User's message\n";
const DYNAMIC_CONTEXT_CLOSE = '</system-context>';

/**
 * 拆开首轮「动态上下文 + 用户输入」合并消息；不是这种消息时返回 null。
 * 它以 `<system-context>` 开头，按前缀规则会被当成系统注入，实际上承载着用户的第一句话。
 */
export function splitDynamicContextUserMessage(
  content: string,
): { context: string; userText: string } | null {
  if (!content.startsWith('<system-context>')) return null;
  const at = content.indexOf(DYNAMIC_CONTEXT_CLOSE + DYNAMIC_CONTEXT_USER_SEPARATOR);
  if (at < 0) return null;
  const contextEnd = at + DYNAMIC_CONTEXT_CLOSE.length;
  return {
    context: content.slice(0, contextEnd),
    userText: content.slice(contextEnd + DYNAMIC_CONTEXT_USER_SEPARATOR.length),
  };
}

/** 统计真实用户消息条数（不含 system 注入块）。 */
export function countRealUserMessages(messages: UnifiedMessage[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue;
    if (isSystemInjectedUserContent(msg.content)) continue;
    count++;
  }
  return count;
}

export function isAlsoNoteMessage(msg: UnifiedMessage): boolean {
  return msg.alsoNote === true;
}

/** 跳过 /also 备注和系统注入，取最近一条真人用户文本。任务切换不用它，只看本轮 userMessage。 */
export function getLatestUserTextForTaskSwitch(messages: UnifiedMessage[], fallback = ''): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user' || isAlsoNoteMessage(msg)) continue;
    const text = extractUserMessageText(msg.content);
    if (!text.trim()) continue;
    if (isSystemInjectedUserContent(text)) continue;
    return text;
  }
  return fallback;
}

/** 倒序查找第一条未被 {@link isSystemInjectedUserContent} 排除的 user 文本。 */
export function getLatestRealUserText(messages: UnifiedMessage[], fallback = ''): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = extractUserMessageText(msg.content);
    if (!text.trim()) continue;
    if (isSystemInjectedUserContent(text)) continue;
    return text;
  }
  return fallback;
}

/** 最近一条真实用户话之前的那一条。同一句重复出现时只跳过最后一次。 */
export function getPreviousRealUserText(messages: UnifiedMessage[], latest: string): string {
  let skippedLatest = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = extractUserMessageText(msg.content);
    if (!text.trim()) continue;
    if (isSystemInjectedUserContent(text)) continue;
    if (!skippedLatest && text === latest) {
      skippedLatest = true;
      continue;
    }
    return text;
  }
  return '';
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
    if (msg.role !== 'user') continue;
    const text = extractUserMessageText(msg.content);
    if (!text.trim()) continue;
    if (isSystemInjectedUserContent(text)) continue;
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
