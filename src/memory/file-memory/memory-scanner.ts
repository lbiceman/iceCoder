/**
 * 记忆目录扫描器。
 *
 * 扫描记忆目录中的 .md 文件，读取 frontmatter，
 * 返回按修改时间排序的记忆头信息列表。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MemoryHeader, FileMemoryType, FileMemoryConfig } from './types.js';
import { FILE_MEMORY_TYPES } from './types.js';

/** frontmatter 最大读取行数 */
const FRONTMATTER_MAX_LINES = 30;

/** 正文预览最大字符数 */
const CONTENT_PREVIEW_MAX_CHARS = 300;

/**
 * 解析 frontmatter 中的记忆类型。
 * 无效或缺失的值返回 undefined。
 */
export function parseMemoryType(raw: unknown): FileMemoryType | undefined {
  if (typeof raw !== 'string') return undefined;
  return FILE_MEMORY_TYPES.find(t => t === raw);
}

/**
 * 从 Markdown 文件内容中解析 frontmatter。
 * 支持 YAML 风格的 --- 分隔符。
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split('\n');
  const result: Record<string, string> = {};

  if (lines[0]?.trim() !== '---') return result;

  for (let i = 1; i < lines.length && i < FRONTMATTER_MAX_LINES; i++) {
    const line = lines[i].trim();
    if (line === '---') break;

    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      result[key] = value;
    }
  }

  return result;
}

/**
 * 扫描记忆目录，返回记忆头信息列表。
 *
 * 单次遍历：读取文件内容时同时获取 mtime，
 * 避免额外的 stat 调用。按修改时间降序排列，
 * 最多返回 maxFiles 条。
 */
export async function scanMemoryFiles(
  memoryDir: string,
  maxFiles: number = 200,
): Promise<MemoryHeader[]> {
  try {
    const entries = await fs.readdir(memoryDir, { recursive: true });
    const mdFiles = entries.filter(
      f => typeof f === 'string' && f.endsWith('.md') && path.basename(f) !== 'MEMORY.md',
    );

    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = path.join(memoryDir, relativePath as string);
        const stat = await fs.stat(filePath);
        const content = await fs.readFile(filePath, 'utf-8');

        // 只读取前 N 行用于解析 frontmatter
        const truncatedContent = content.split('\n').slice(0, FRONTMATTER_MAX_LINES).join('\n');
        const frontmatter = parseFrontmatter(truncatedContent);

        // 解析新增元数据字段
        const confidence = frontmatter.confidence ? parseFloat(frontmatter.confidence) : 0.5;
        const recallCount = frontmatter.recallCount ? parseInt(frontmatter.recallCount, 10) : 0;
        const lastRecalledAt = frontmatter.lastRecalledAt;
        const createdAt = frontmatter.createdAt;
        const tagsRaw = frontmatter.tags;
        const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
        const relatedToRaw = frontmatter.relatedTo;
        const relatedTo = relatedToRaw ? relatedToRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

        return {
          filename: relativePath as string,
          filePath,
          mtimeMs: stat.mtimeMs,
          description: frontmatter.description || null,
          type: parseMemoryType(frontmatter.type),
          confidence: Number.isFinite(confidence) ? confidence : 0.5,
          recallCount: Number.isFinite(recallCount) ? recallCount : 0,
          lastRecalledMs: lastRecalledAt ? new Date(lastRecalledAt).getTime() || 0 : 0,
          createdMs: createdAt ? new Date(createdAt).getTime() || stat.birthtimeMs : stat.birthtimeMs,
          tags,
          source: frontmatter.source || undefined,
          contentPreview: extractContentPreview(content),
          relatedTo,
        };
      }),
    );

    return headerResults
      .filter((r): r is PromiseFulfilledResult<MemoryHeader> => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxFiles);
  } catch {
    return [];
  }
}

/**
 * 从 Markdown 文件内容中提取正文预览（跳过 frontmatter）。
 * 返回 frontmatter 之后的前 N 个字符，去除空行和 Markdown 格式标记。
 */
function extractContentPreview(content: string): string {
  const lines = content.split('\n');
  let bodyStart = 0;

  // 跳过 frontmatter（--- ... ---）
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        break;
      }
    }
  }

  // 提取正文，去除空行和纯格式行（如 --- 分隔线、* 时间戳行）
  const bodyLines = lines.slice(bodyStart)
    .map(l => l.trim())
    .filter(l => l.length > 0 && l !== '---' && !l.startsWith('*'));

  const body = bodyLines.join(' ');
  return body.length > CONTENT_PREVIEW_MAX_CHARS
    ? body.substring(0, CONTENT_PREVIEW_MAX_CHARS)
    : body;
}

/**
 * 将记忆头信息格式化为文本清单。
 * 每行一个文件：[类型] 文件名 (时间戳): 描述 | 正文预览
 *
 * contentPreview 附在描述后面，用 | 分隔，帮助 LLM 看到更多上下文。
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : '';
      const ts = new Date(m.mtimeMs).toISOString();
      const desc = m.description || '';
      // 附上 contentPreview（截取前 150 字符，避免 manifest 过大）
      const preview = m.contentPreview
        ? ` | ${m.contentPreview.substring(0, 150)}`
        : '';
      return desc
        ? `- ${tag}${m.filename} (${ts}): ${desc}${preview}`
        : `- ${tag}${m.filename} (${ts})${preview}`;
    })
    .join('\n');
}
