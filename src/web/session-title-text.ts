/**
 * 会话侧栏标题的纯文本规则。服务端和恢复索引共用，不读磁盘。
 */

export const SESSION_TITLE_MAX_LEN = 50;

/**
 * 各语言的占位标题。新建会话时客户端按当前语言写入其中之一，
 * 首条文字消息可以覆盖；用户改过的标题不在这里，不会被盖掉。
 */
export const PLACEHOLDER_SESSION_TITLES = new Set([
  '新会话',
  '默认会话',
  '未命名',
  'New chat',
  'Default chat',
  'Untitled',
]);

export function normalizeSessionTitleSource(prompt: string): string {
  return String(prompt || '').replace(/\s+/g, ' ').trim();
}

/** 将用户文字截成侧栏标题。超出长度时末尾用省略号。 */
export function deriveSessionTitleFromPrompt(prompt: string): string {
  const text = normalizeSessionTitleSource(prompt);
  if (!text) return '未命名';
  if (text.length <= SESSION_TITLE_MAX_LEN) return text;
  return `${text.slice(0, SESSION_TITLE_MAX_LEN - 1)}…`;
}

export function isPlaceholderSessionTitle(title: string): boolean {
  return PLACEHOLDER_SESSION_TITLES.has(String(title || '').trim());
}
