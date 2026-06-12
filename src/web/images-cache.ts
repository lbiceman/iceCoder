/**
 * 将前端粘贴/拖拽的 inline base64 图片落盘，供非 vision 模型通过 image_read 读取。
 * 开发环境：data/imagesCache/{sessionId}/
 * 生产环境：OS 用户缓存目录/imagesCache/{sessionId}/
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '../llm/types.js';
import { getImagesCacheSessionDir } from '../cli/paths.js';

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

export interface PersistedInlineImage {
  absolutePath: string;
  mimeType: string;
}

export function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  try {
    return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
  } catch {
    return null;
  }
}

/** 将 data URL 图片写入会话专属 imagesCache 目录。 */
export async function persistInlineImages(
  dataUrls: string[],
  sessionId: string,
): Promise<PersistedInlineImage[]> {
  if (dataUrls.length === 0 || !sessionId.trim()) return [];

  const dir = getImagesCacheSessionDir(sessionId);
  await fs.mkdir(dir, { recursive: true });

  const results: PersistedInlineImage[] = [];
  for (const dataUrl of dataUrls) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) continue;

    const ext = MIME_TO_EXT[parsed.mimeType] ?? '.png';
    const fileName = `${randomUUID()}${ext}`;
    const absolutePath = path.join(dir, fileName);
    await fs.writeFile(absolutePath, parsed.buffer);

    results.push({
      absolutePath,
      mimeType: parsed.mimeType,
    });
  }
  return results;
}

/** 将上传临时文件复制进 imagesCache（避免 temp 被清理、统一 workspace referenceReads）。 */
export async function persistUploadedImageFiles(
  filePaths: string[],
  sessionId: string,
): Promise<PersistedInlineImage[]> {
  if (filePaths.length === 0 || !sessionId.trim()) return [];

  const dir = getImagesCacheSessionDir(sessionId);
  await fs.mkdir(dir, { recursive: true });

  const results: PersistedInlineImage[] = [];
  for (const src of filePaths) {
    try {
      const ext = path.extname(src).toLowerCase() || '.png';
      const fileName = `${randomUUID()}${ext}`;
      const absolutePath = path.join(dir, fileName);
      await fs.copyFile(src, absolutePath);
      results.push({
        absolutePath,
        mimeType: EXT_TO_MIME[ext] ?? 'image/png',
      });
    } catch {
      /* skip unreadable upload */
    }
  }
  return results;
}

/** UI / REST 展示用：会话图片 API 相对路径。 */
export function buildSessionImageApiUrl(sessionId: string, absolutePath: string): string {
  const fileName = path.basename(absolutePath);
  return `/api/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(fileName)}`;
}

/** 解析并校验 imagesCache 内图片的绝对路径（防目录穿越）。 */
export function resolveSessionImageFile(
  sessionId: string,
  fileName: string,
): string | undefined {
  if (!sessionId.trim() || !fileName.trim()) return undefined;
  const base = path.basename(fileName);
  if (base !== fileName || base.includes('..')) return undefined;
  const abs = path.join(getImagesCacheSessionDir(sessionId), base);
  const cacheRoot = path.resolve(getImagesCacheSessionDir(sessionId));
  if (!path.resolve(abs).toLowerCase().startsWith(cacheRoot.toLowerCase())) return undefined;
  return abs;
}

/** 删除会话 imagesCache 目录（会话删除时调用）。 */
export async function deleteSessionImagesCache(sessionId: string): Promise<void> {
  if (!sessionId.trim()) return;
  await fs.rm(getImagesCacheSessionDir(sessionId), { recursive: true, force: true });
}

export function buildImagePathHint(imageAbsolutePaths: string[], supportsVision: boolean): string {
  if (imageAbsolutePaths.length === 0) return '';

  if (supportsVision) {
    return '用户图片已随本条消息一并发送（多模态），请直接分析，无需调用 image_read。';
  }

  const lines = imageAbsolutePaths.map((p, i) => `${i + 1}. ${p}`);
  return [
    '用户图片已保存到以下绝对路径。分析图片时请调用 image_read 工具，path 参数必须使用下方列出的完整路径（禁止使用 user_uploaded_image 等占位符）：',
    ...lines,
  ].join('\n');
}

export interface BuildUserMessageWithImagesParams {
  userText: string;
  filePaths: string[];
  imageAbsolutePaths: string[];
  imageDataUrls: string[];
  supportsVision: boolean;
}

export function buildUserMessageWithImages(params: BuildUserMessageWithImagesParams): {
  content: string | ContentBlock[];
  harnessUserMessage: string;
} {
  const { userText, filePaths, imageAbsolutePaths, imageDataUrls, supportsVision } = params;

  const baseText = userText || (imageDataUrls.length > 0 || imageAbsolutePaths.length > 0 ? '请分析这些图片' : '');

  const fileHint = filePaths.length > 0
    ? '请使用 parse_document 或 read_file 工具读取上述文件路径来分析文件内容。'
    : '';

  const imagePathHint = buildImagePathHint(imageAbsolutePaths, supportsVision);

  const textParts = [baseText, fileHint, imagePathHint].filter(Boolean).join('\n\n');
  const harnessUserMessage = textParts || baseText;

  if (imageDataUrls.length === 0) {
    return { content: harnessUserMessage, harnessUserMessage };
  }

  if (supportsVision) {
    const blocks: ContentBlock[] = [{ type: 'text', text: textParts }];
    for (const dataUrl of imageDataUrls) {
      blocks.push({ type: 'image', imageUrl: dataUrl });
    }
    return { content: blocks, harnessUserMessage };
  }

  return { content: harnessUserMessage, harnessUserMessage };
}
