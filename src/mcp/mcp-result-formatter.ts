/**
 * 将 MCP tools/call 结果格式化为 LLM 可读文本。
 * Puppeteer 等 MCP 截图以 image 块返回（仅存于 MCP 进程内存），需落盘后 image_read 才能读取。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getMcpCacheDir } from '../cli/paths.js';
import { parseDataUrl } from '../web/images-cache.js';
import type { MCPToolResult } from './types.js';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

export interface FormattedMcpResult {
  output: string;
  savedImagePaths: string[];
}

function buildImageReadHint(absolutePaths: string[]): string {
  if (absolutePaths.length === 0) return '';
  const lines = absolutePaths.map((p, i) => `${i + 1}. ${p}`);
  return [
    '截图/图片已落盘到本地。分析时请调用 image_read，path 必须使用下方完整绝对路径（禁止猜测工作区根目录下的文件名）：',
    ...lines,
  ].join('\n');
}

async function persistMcpImage(
  buffer: Buffer,
  mimeType: string,
  label?: string,
): Promise<string> {
  const dir = getMcpCacheDir();
  await fs.mkdir(dir, { recursive: true });

  const ext = MIME_TO_EXT[mimeType] ?? '.png';
  const safeLabel = label?.replace(/[^\w.-]+/g, '_').slice(0, 40);
  const fileName = safeLabel ? `${safeLabel}-${randomUUID()}${ext}` : `${randomUUID()}${ext}`;
  const absolutePath = path.join(dir, fileName);
  await fs.writeFile(absolutePath, buffer);
  return absolutePath;
}

function isDataUrlText(text: string): boolean {
  return /^data:image\/[^;]+;base64,/i.test(text.trim());
}

/**
 * 格式化 MCP 工具结果：保留文本，将 image / data URL 落盘并附带 image_read 路径指引。
 */
export async function formatMcpToolResult(result: MCPToolResult): Promise<FormattedMcpResult> {
  const textParts: string[] = [];
  const savedImagePaths: string[] = [];

  for (const item of result.content ?? []) {
    if (item.type === 'text' && item.text) {
      const text = item.text.trim();
      if (isDataUrlText(text)) {
        const parsed = parseDataUrl(text);
        if (parsed) {
          const absolutePath = await persistMcpImage(parsed.buffer, parsed.mimeType);
          savedImagePaths.push(absolutePath);
          continue;
        }
      }
      textParts.push(item.text);
      continue;
    }

    if (item.type === 'image' && item.data) {
      const mimeType = item.mimeType ?? 'image/png';
      const buffer = Buffer.from(item.data, 'base64');
      const absolutePath = await persistMcpImage(buffer, mimeType);
      savedImagePaths.push(absolutePath);
    }
  }

  const imageHint = buildImageReadHint(savedImagePaths);
  const body = textParts.join('\n').trim();
  const output = [body, imageHint].filter(Boolean).join('\n\n') || '(无文本输出)';

  return { output, savedImagePaths };
}
