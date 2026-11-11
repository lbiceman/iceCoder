/**
 * 锁仓时写一次仓库大纲，作为单独的 system-reminder 追加。
 * 不改用户原话。历史里已经有同一根目录的大纲就不再写。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { UnifiedMessage } from '../llm/types.js';

export const WORKSPACE_OUTLINE_OPEN = '[Workspace Outline]';
export const WORKSPACE_OUTLINE_CLOSE = '[/Workspace Outline]';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'out',
  'build',
  '.next',
  '.iceCoder',
]);

const MAX_ENTRIES = 40;
const MAX_DEPTH = 2;
const MAX_CHARS = 1_500;

function messageText(message: UnifiedMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(block => block.text ?? '').join('\n');
}

export function historyHasOutline(messages: readonly UnifiedMessage[], root: string): boolean {
  const resolved = path.resolve(root);
  const needle = `Repository root: ${resolved}`;
  return messages.some(message => {
    const text = messageText(message);
    return text.includes(WORKSPACE_OUTLINE_OPEN) && text.includes(needle);
  });
}

async function walk(
  dir: string,
  rel: string,
  depth: number,
  lines: string[],
  budget: { n: number },
): Promise<void> {
  if (budget.n <= 0 || depth > MAX_DEPTH) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (budget.n <= 0) return;
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    budget.n -= 1;
    lines.push(`${entry.isDirectory() ? 'dir' : 'file'} ${relPath}`);
    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), relPath, depth + 1, lines, budget);
    }
  }
}

export async function buildWorkspaceOutline(root: string): Promise<string | null> {
  const resolved = path.resolve(root);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const lines: string[] = [];
  await walk(resolved, '', 1, lines, { n: MAX_ENTRIES });
  const names = new Set(lines.map(line => line.slice(line.indexOf(' ') + 1)));
  const entryPoints = ['package.json', 'tsconfig.json', 'README.md', 'src']
    .filter(name => names.has(name));

  const body = [
    WORKSPACE_OUTLINE_OPEN,
    `Repository root: ${resolved}`,
    'Frozen for this workspace root. Prefer it over listing the whole tree.',
    entryPoints.length > 0 ? `Entry points: ${entryPoints.join(', ')}` : '',
    ...lines,
    WORKSPACE_OUTLINE_CLOSE,
  ].filter(Boolean).join('\n');

  if (body.length <= MAX_CHARS) return body;
  return `${body.slice(0, MAX_CHARS)}\n…\n${WORKSPACE_OUTLINE_CLOSE}`;
}

/**
 * 单独追加一条系统提醒，不改用户原话。
 * 硬压缩时保留，避免压缩后当成没写过再追加一次。
 */
export async function appendWorkspaceOutlineOnce(
  messages: UnifiedMessage[],
  root: string | undefined,
): Promise<boolean> {
  if (!root) return false;
  try {
    if (historyHasOutline(messages, root)) return false;
    const outline = await buildWorkspaceOutline(root);
    if (!outline) return false;
    const reminder: UnifiedMessage = {
      role: 'user',
      content: `<system-reminder>\n${outline}\n</system-reminder>`,
      preserveOnCompaction: true,
    };
    messages.push(reminder);
    return true;
  } catch {
    return false;
  }
}
