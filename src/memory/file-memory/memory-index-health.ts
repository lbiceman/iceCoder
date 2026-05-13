/**
 * MEMORY.md 索引健康检查（无 LLM）。
 *
 * 用于检测死链：索引中指向的 .md 在记忆目录中不存在。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 与 {@link countDeadLinksInMemoryIndex} 相同的相对路径判定：是否应对该 href 做本地存在性检查 */
async function shouldCheckLocalMarkdownHref(root: string, hrefRaw: string): Promise<'skip' | 'check' | 'dead'> {
  const raw = hrefRaw.trim();
  if (!raw || /^(https?:|mailto:)/i.test(raw)) return 'skip';

  const pathPart = raw.split('#')[0].trim();
  if (!pathPart) return 'skip';

  const normalized = path.normalize(pathPart);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return 'skip';

  const target = path.normalize(path.join(root, pathPart));
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(rootWithSep)) return 'skip';

  try {
    await fs.access(target);
    return 'check'; // exists
  } catch {
    return 'dead';
  }
}

/**
 * 统计 MEMORY.md 内指向本地 markdown 的链接中，目标文件不存在的数量。
 *
 * @returns dead — 死链数；checked — 参与校验的本地相对链接数（不含 http(s)/mailto/纯锚点）
 */
export async function countDeadLinksInMemoryIndex(memoryDir: string): Promise<{ dead: number; checked: number }> {
  const root = path.resolve(memoryDir);
  const indexPath = path.join(root, 'MEMORY.md');
  let content: string;
  try {
    content = await fs.readFile(indexPath, 'utf-8');
  } catch {
    return { dead: 0, checked: 0 };
  }

  const linkRe = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  let dead = 0;
  let checked = 0;

  while ((m = linkRe.exec(content)) !== null) {
    const raw = m[1].trim();
    const status = await shouldCheckLocalMarkdownHref(root, raw);
    if (status === 'skip') continue;
    checked++;
    if (status === 'dead') dead++;
  }

  return { dead, checked };
}

/**
 * 从 MEMORY.md 中移除指向不存在文件的 Markdown 链接（`[text](relative.md)`）。
 * 用于淘汰/Dream 删除文件后与索引同步，降低 stale_index 反复触发。
 *
 * @returns removedLinks — 删除的链接数；wrote — 是否写回了文件
 */
export async function repairDeadLinksInMemoryIndex(
  memoryDir: string,
): Promise<{ removedLinks: number; wrote: boolean }> {
  const root = path.resolve(memoryDir);
  const indexPath = path.join(root, 'MEMORY.md');
  let content: string;
  try {
    content = await fs.readFile(indexPath, 'utf-8');
  } catch {
    return { removedLinks: 0, wrote: false };
  }

  const mdLinkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  const matches = [...content.matchAll(mdLinkRe)];
  if (matches.length === 0) {
    return { removedLinks: 0, wrote: false };
  }

  let removedLinks = 0;
  let out = '';
  let lastIndex = 0;
  for (const m of matches) {
    const idx = m.index ?? 0;
    const full = m[0];
    const href = m[2];
    out += content.slice(lastIndex, idx);
    const status = await shouldCheckLocalMarkdownHref(root, href);
    if (status === 'dead') {
      removedLinks++;
    } else {
      out += full;
    }
    lastIndex = idx + full.length;
  }
  out += content.slice(lastIndex);

  if (removedLinks === 0) {
    return { removedLinks: 0, wrote: false };
  }

  const collapsed = out.replace(/\n{3,}/g, '\n\n');
  await fs.writeFile(indexPath, collapsed.trimEnd() + '\n', 'utf-8');
  return { removedLinks, wrote: true };
}
