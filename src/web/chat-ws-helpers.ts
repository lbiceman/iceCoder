/**
 * chat-ws 纯函数：消息 id、路径规范化。零进程状态。
 */

import path from 'path';

const CLIENT_MESSAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseClientMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return CLIENT_MESSAGE_ID_RE.test(id) ? id : null;
}

export function normalizeReferencePath(raw: string): string {
  return path.win32.normalize(raw.trim().replace(/\//g, '\\')).toLowerCase();
}

/** @ 文件引用会作为独立路径行进入展示文本；工作区锁定时必须忽略这些引用行。 */
export function stripReferencePathLinesForWorkspaceLock(
  message: string,
  referencePaths: string[],
): string {
  if (!referencePaths.length) return message;
  const refs = new Set(referencePaths.map(normalizeReferencePath));
  return message
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !refs.has(normalizeReferencePath(trimmed));
    })
    .join('\n')
    .trim();
}

export function isSessionImageApiUrl(url: string): boolean {
  return typeof url === 'string'
    && url.startsWith('/api/sessions/')
    && url.includes('/images/');
}

/** 前端 open 气泡注入的目录浏览提示（有无 `~` 都算） */
const OPEN_UI_HINT_RE = /\[Directory browsing\]|【(?:文件浏览器模式|目录列举|目录浏览)/;

function isOpenCommandLine(line: string): boolean {
  return line === '~open' || line === '/open' || line === 'open';
}

export function isOpenLegacyCommand(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === '~open' || trimmed.startsWith('~open\n') || trimmed.startsWith('~open ')) return true;
  if (trimmed === '/open' || trimmed.startsWith('/open\n') || trimmed.startsWith('/open ')) return true;
  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  if (!isOpenCommandLine(firstLine)) return false;
  return trimmed === firstLine || OPEN_UI_HINT_RE.test(trimmed);
}
