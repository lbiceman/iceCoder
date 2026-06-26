/**
 * MEMORY.md 索引健康检查（无 LLM）。
 *
 * 支持：
 * - Markdown 链接 `[text](relative.md)`
 * - 表格首列 `| filename.md | 要点 |`
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomic-write.js';
import type { MemoryHeader } from './types.js';

/** 索引健康报告 */
export interface MemoryIndexHealthReport {
  /** 索引中指向不存在文件的引用数 */
  dead: number;
  /** 参与校验的索引引用总数 */
  checked: number;
  /** 索引中唯一 .md 引用数 */
  indexed: number;
  /** 磁盘上主题记忆文件数（不含 MEMORY.md） */
  onDisk: number;
  /** 磁盘有、索引无 */
  orphans: number;
  /** 索引有、磁盘无的文件名（最多 20 条） */
  deadFiles: string[];
  /** 未入索引的文件名（最多 20 条） */
  orphanFiles: string[];
}

const TABLE_MD_CELL_RE = /\|\s*([^\s|/\\]+\.md)\s*\|/gi;
const MD_LINK_HREF_RE = /\]\(([^)]+)\)/g;

/** 从 MEMORY.md 文本提取被索引的 .md 文件名（小写键用于比对） */
export function extractIndexedMarkdownRefs(content: string): Set<string> {
  const refs = new Set<string>();

  for (const m of content.matchAll(MD_LINK_HREF_RE)) {
    const raw = m[1].trim();
    const pathPart = raw.split('#')[0].trim();
    if (pathPart.toLowerCase().endsWith('.md')) {
      refs.add(path.basename(pathPart));
    }
  }

  for (const m of content.matchAll(TABLE_MD_CELL_RE)) {
    const name = m[1].trim();
    if (name.toLowerCase().endsWith('.md') && name !== 'MEMORY.md') {
      refs.add(name);
    }
  }

  return refs;
}

/** 与 {@link countDeadLinksInMemoryIndex} 相同的相对路径判定 */
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
    return 'check';
  } catch {
    return 'dead';
  }
}

async function fileExistsInMemoryDir(root: string, filename: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, filename));
    return true;
  } catch {
    return false;
  }
}

/**
 * 完整索引健康审计：死链、孤儿、覆盖率。
 */
export async function auditMemoryIndexHealth(
  memoryDir: string,
  onDiskFilenames?: string[],
): Promise<MemoryIndexHealthReport> {
  const root = path.resolve(memoryDir);
  const indexPath = path.join(root, 'MEMORY.md');

  let onDisk = onDiskFilenames;
  if (!onDisk) {
    try {
      const entries = await fs.readdir(root);
      onDisk = entries.filter(f => f.endsWith('.md') && f !== 'MEMORY.md');
    } catch {
      onDisk = [];
    }
  }

  const onDiskSet = new Set(onDisk);
  let content = '';
  try {
    content = await fs.readFile(indexPath, 'utf-8');
  } catch {
    return {
      dead: 0,
      checked: 0,
      indexed: 0,
      onDisk: onDisk.length,
      orphans: onDisk.length,
      deadFiles: [],
      orphanFiles: onDisk.slice(0, 20),
    };
  }

  const indexedRefs = extractIndexedMarkdownRefs(content);
  const deadFiles: string[] = [];
  let dead = 0;
  let checked = indexedRefs.size;

  for (const ref of indexedRefs) {
    const exists = await fileExistsInMemoryDir(root, ref);
    if (!exists) {
      dead++;
      if (deadFiles.length < 20) deadFiles.push(ref);
    }
  }

  const orphanFiles = onDisk.filter(f => !indexedRefs.has(f));
  const orphans = orphanFiles.length;

  return {
    dead,
    checked,
    indexed: indexedRefs.size,
    onDisk: onDisk.length,
    orphans,
    deadFiles,
    orphanFiles: orphanFiles.slice(0, 20),
  };
}

/**
 * 统计 MEMORY.md 内本地 .md 引用中目标不存在的数量（链接 + 表格）。
 */
export async function countDeadLinksInMemoryIndex(memoryDir: string): Promise<{ dead: number; checked: number }> {
  const report = await auditMemoryIndexHealth(memoryDir);
  return { dead: report.dead, checked: report.checked };
}

/**
 * 从 MEMORY.md 移除死链（Markdown 链接 + 表格行）。
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

  let removedLinks = 0;
  const lines = content.split('\n');
  const outLines: string[] = [];

  for (const line of lines) {
    let drop = false;

    const linkMatches = [...line.matchAll(/\[([^\]]*)\]\(([^)]+)\)/g)];
    for (const m of linkMatches) {
      const status = await shouldCheckLocalMarkdownHref(root, m[2]);
      if (status === 'dead') {
        drop = true;
        removedLinks++;
        break;
      }
    }

    if (!drop) {
      const tableMatch = line.match(/^\|\s*([^\s|/\\]+\.md)\s*\|/i);
      if (tableMatch) {
        const fname = tableMatch[1].trim();
        const exists = await fileExistsInMemoryDir(root, fname);
        if (!exists) {
          drop = true;
          removedLinks++;
        }
      }
    }

    if (!drop) outLines.push(line);
  }

  if (removedLinks === 0) {
    return { removedLinks: 0, wrote: false };
  }

  const collapsed = outLines.join('\n').replace(/\n{3,}/g, '\n\n');
  await writeFileAtomic(indexPath, collapsed.trimEnd() + '\n', 'utf-8');
  return { removedLinks, wrote: true };
}

const INDEX_SECTION_ORDER: Array<{ type: string; title: string }> = [
  { type: 'user', title: '用户偏好' },
  { type: 'project', title: '项目规则' },
  { type: 'feedback', title: '反馈与纠错' },
  { type: 'observation', title: '观察记录' },
];

/**
 * 根据扫描结果确定性重建 MEMORY.md 表格索引（LLM 未提供 new_index 时的兜底）。
 */
export async function rebuildMemoryIndexFromMemories(
  memoryDir: string,
  memories: MemoryHeader[],
  maxEntries = 120,
): Promise<{ wrote: boolean; entryCount: number }> {
  const sorted = [...memories].sort((a, b) => {
    const scoreA = (a.recallCount || 0) * 2 + (a.confidence || 0.5) + (a.type === 'user' ? 1.5 : 0);
    const scoreB = (b.recallCount || 0) * 2 + (b.confidence || 0.5) + (b.type === 'user' ? 1.5 : 0);
    return scoreB - scoreA;
  }).slice(0, maxEntries);

  const byType = new Map<string, MemoryHeader[]>();
  for (const mem of sorted) {
    const t = mem.type || 'project';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t)!.push(mem);
  }

  const sections: string[] = ['# MEMORY.md', ''];
  const usedTypes = new Set<string>();

  for (const { type, title } of INDEX_SECTION_ORDER) {
    const group = byType.get(type);
    if (!group?.length) continue;
    usedTypes.add(type);
    sections.push(`## ${title}`);
    sections.push('| 文件 | 要点 |');
    sections.push('|------|------|');
    for (const mem of group) {
      const hint = (mem.description || mem.filename.replace(/\.md$/i, '')).replace(/\|/g, '/').slice(0, 120);
      sections.push(`| ${mem.filename} | ${hint} |`);
    }
    sections.push('');
  }

  for (const [type, group] of byType) {
    if (usedTypes.has(type)) continue;
    sections.push(`## ${type}`);
    sections.push('| 文件 | 要点 |');
    sections.push('|------|------|');
    for (const mem of group) {
      const hint = (mem.description || mem.filename.replace(/\.md$/i, '')).replace(/\|/g, '/').slice(0, 120);
      sections.push(`| ${mem.filename} | ${hint} |`);
    }
    sections.push('');
  }

  const indexPath = path.join(path.resolve(memoryDir), 'MEMORY.md');
  await writeFileAtomic(indexPath, sections.join('\n').trimEnd() + '\n', 'utf-8');
  return { wrote: true, entryCount: sorted.length };
}
