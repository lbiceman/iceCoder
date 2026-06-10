/**
 * 记忆索引（MEMORY.md）维护器 — 确定性规则，零 LLM。
 *
 * 职责：
 * - upsertIndexRow：写时同步更新 MEMORY.md 表格一行
 * - removeIndexRows：删文件时移除对应行
 * - rebuildIndexIfDrifted：孤儿检测 → 重建索引
 * - repairIndexIfNeeded：死链修复（移除不存在的引用行）
 *
 * 复用 memory-index-health.ts 的底层能力：
 *   auditMemoryIndexHealth / repairDeadLinksInMemoryIndex / rebuildMemoryIndexFromMemories
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryHeader } from './types.js';
import {
  auditMemoryIndexHealth,
  rebuildMemoryIndexFromMemories,
  repairDeadLinksInMemoryIndex,
} from './memory-index-health.js';
import { scanMemoryFiles } from './memory-scanner.js';
import { getScannerCache } from './memory-scanner-cache.js';
import { getMemoryTelemetry } from './memory-telemetry.js';

/** 索引写入串行化锁（同进程内） */
let indexWriteChain: Promise<void> = Promise.resolve();

function sequentialIndexWrite(fn: () => Promise<void>): Promise<void> {
  indexWriteChain = indexWriteChain.then(fn, fn);
  return indexWriteChain;
}

export interface IndexRepairResult {
  removedLinks: number;
  wrote: boolean;
}

export interface RebuildResult {
  wrote: boolean;
  entryCount: number;
}

export interface RebuildOpts {
  /** 索引最大条目数，默认 120 */
  maxEntries?: number;
}

/**
 * MEMORY.md 缺失或为空时，从磁盘扫描结果 bootstrap 索引。
 */
export async function ensureMemoryIndexBootstrapped(memoryDir: string): Promise<boolean> {
  const root = path.resolve(memoryDir);
  const indexPath = path.join(root, 'MEMORY.md');

  let needsBootstrap = false;
  try {
    const content = await fs.readFile(indexPath, 'utf-8');
    if (!content.trim()) needsBootstrap = true;
  } catch {
    needsBootstrap = true;
  }

  if (!needsBootstrap) return false;

  const memories = await scanMemoryFiles(root, 500);
  const result = await rebuildMemoryIndexFromMemories(root, memories, 120);
  if (result.wrote) {
    getScannerCache().invalidate(root);
    getMemoryTelemetry().logIndexRebuild({
      memoryDir: root,
      entryCount: result.entryCount,
      trigger: 'bootstrap',
    }).catch(() => {});
  }
  return result.wrote;
}

/**
 * 从 MEMORY.md 中更新或新增一条索引行。
 * 文件名已存在 → 更新描述；不存在 → 追加到对应类型分区末尾。
 *
 * 若 MEMORY.md 不存在或为空 → 先 bootstrap 再 upsert。
 */
export async function upsertIndexRow(
  memoryDir: string,
  header: Pick<MemoryHeader, 'filename' | 'description' | 'type'>,
): Promise<void> {
  return sequentialIndexWrite(async () => {
    const root = path.resolve(memoryDir);
    const indexPath = path.join(root, 'MEMORY.md');

    await ensureMemoryIndexBootstrapped(root);

    let content: string;
    try {
      content = await fs.readFile(indexPath, 'utf-8');
    } catch {
      return;
    }

    if (!content.trim()) return;

    const filename = header.filename;
    const hint = (header.description || filename.replace(/\.md$/i, ''))
      .replace(/\|/g, '/')
      .slice(0, 120);

    // 检查是否已存在该文件的行
    const lines = content.split('\n');
    let found = false;
    const out: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Markdown 链接: [text](filename.md)
      const linkMatch = line.match(/\[([^\]]*)\]\(([^)]*)\)/);
      if (linkMatch) {
        const href = linkMatch[2].trim().split('#')[0];
        if (href === filename || path.basename(href) === filename) {
          out.push(`- [${linkMatch[1]}](${filename}) — ${hint}`);
          found = true;
          continue;
        }
      }

      // 表格行: | filename.md | ... |
      const tableMatch = line.match(/^\|\s*([^\s|/\\]+\.md)\s*\|/i);
      if (tableMatch) {
        const fname = tableMatch[1].trim();
        if (fname === filename) {
          out.push(`| ${filename} | ${hint} |`);
          found = true;
          continue;
        }
      }

      out.push(line);
    }

    if (found) {
      await fs.writeFile(indexPath, out.join('\n'), 'utf-8');
    } else {
      // 新文件 — 追加到对应类型分区
      const type = header.type || 'project';
      const sectionTitle = SECTION_TITLES[type] || type;
      const newLine = `| ${filename} | ${hint} |`;

      // 找对应分区插入
      const sectionHeader = `## ${sectionTitle}`;
      let inserted = false;
      const outLines: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        outLines.push(lines[i]);
        if (lines[i].trim() === sectionHeader) {
          // 在分区标题后插入（跳过标题后的表头两行）
          if (i + 2 < lines.length && lines[i + 1].trim().startsWith('|') && lines[i + 2].trim().startsWith('|')) {
            outLines.push(newLine);
            inserted = true;
          } else {
            // 没有表头则直接在标题后追加
            outLines.push('| 文件 | 要点 |');
            outLines.push('|------|------|');
            outLines.push(newLine);
            inserted = true;
          }
        }
      }

      if (!inserted) {
        // 没有对应分区 — 追加到末尾
        outLines.push('');
        outLines.push(`## ${sectionTitle}`);
        outLines.push('| 文件 | 要点 |');
        outLines.push('|------|------|');
        outLines.push(newLine);
      }

      await fs.writeFile(indexPath, outLines.join('\n'), 'utf-8');
    }

    getScannerCache().invalidate(memoryDir);
  });
}

const SECTION_TITLES: Record<string, string> = {
  user: '用户偏好',
  project: '项目规则',
  feedback: '反馈与纠错',
  observation: '观察记录',
};

/**
 * 从 MEMORY.md 中移除一批文件名的行。
 */
export async function removeIndexRows(
  memoryDir: string,
  filenames: string[],
): Promise<void> {
  if (filenames.length === 0) return;
  const set = new Set(filenames);

  return sequentialIndexWrite(async () => {
    const root = path.resolve(memoryDir);
    const indexPath = path.join(root, 'MEMORY.md');

    let content: string;
    try {
      content = await fs.readFile(indexPath, 'utf-8');
    } catch {
      return;
    }

    const lines = content.split('\n');
    const out: string[] = [];

    for (const line of lines) {
      let drop = false;

      // Markdown 链接
      const linkMatch = line.match(/\]\(([^)]+)\)/);
      if (linkMatch) {
        const href = linkMatch[1].trim().split('#')[0];
        if (set.has(href) || set.has(path.basename(href))) {
          drop = true;
        }
      }

      // 表格行
      if (!drop) {
        const tableMatch = line.match(/^\|\s*([^\s|/\\]+\.md)\s*\|/i);
        if (tableMatch && set.has(tableMatch[1].trim())) {
          drop = true;
        }
      }

      if (!drop) out.push(line);
    }

    if (out.length < lines.length) {
      const collapsed = out.join('\n').replace(/\n{3,}/g, '\n\n');
      await fs.writeFile(indexPath, collapsed.trimEnd() + '\n', 'utf-8');
      getScannerCache().invalidate(memoryDir);
    }
  });
}

/**
 * 修复 MEMORY.md 中的死链（移除指向不存在文件的引用行）。
 */
export async function repairIndexIfNeeded(memoryDir: string): Promise<IndexRepairResult> {
  return await repairDeadLinksInMemoryIndex(memoryDir);
}

/**
 * 检测到索引漂移（孤儿文件 ≥ 阈值，死链 < 阈值）时重建整个 MEMORY.md。
 */
export async function rebuildIndexIfDrifted(
  memoryDir: string,
  opts?: RebuildOpts,
): Promise<RebuildResult> {
  const memories = await scanMemoryFiles(memoryDir, 500);
  const maxEntries = opts?.maxEntries ?? 120;
  const result = await rebuildMemoryIndexFromMemories(memoryDir, memories, maxEntries);
  if (result.wrote) {
    getScannerCache().invalidate(memoryDir);
    getMemoryTelemetry().logIndexRebuild({
      memoryDir: path.resolve(memoryDir),
      entryCount: result.entryCount,
      trigger: 'drift',
    }).catch(() => {});
  }
  return result;
}
