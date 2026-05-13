/**
 * MEMORY.md 索引健康检查（无 LLM）。
 *
 * 用于检测死链：索引中指向的 .md 在记忆目录中不存在。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

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
    if (!raw || /^(https?:|mailto:)/i.test(raw)) continue;

    const pathPart = raw.split('#')[0].trim();
    if (!pathPart) continue;

    const normalized = path.normalize(pathPart);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      continue;
    }

    checked++;
    const target = path.normalize(path.join(root, pathPart));
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (target !== root && !target.startsWith(rootWithSep)) {
      continue;
    }

    try {
      await fs.access(target);
    } catch {
      dead++;
    }
  }

  return { dead, checked };
}
