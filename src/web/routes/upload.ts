/**
 * 文件上传路由。
 * 接收前端上传的文件，保存到临时目录，返回 fileId 供后续消息引用。
 * 支持中文文件名（修复 multer latin1 编码问题）。
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

/** 与 multer 单文件上限一致 */
export const CHAT_UPLOAD_MAX_FILE_BYTES = 50 * 1024 * 1024;

/** 多模态 / resolveFileReferences 识别的图片扩展名 */
export const CHAT_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'] as const;

/** 前端可参考的扩展名（实际上传入口不按后缀拦截） */
const CHAT_SUGGESTED_EXTENSIONS = [
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.xml',
  '.html',
  '.htm',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.xmind',
  '.zip',
  ...CHAT_IMAGE_EXTENSIONS,
] as const;

/** 上传临时目录 */
const UPLOAD_DIR = path.join(os.tmpdir(), 'iceCoder-uploads');

/** 已上传文件的元数据缓存 */
const uploadedFiles = new Map<string, { originalName: string; filePath: string; size: number; mimeType: string }>();

/** 确保上传目录存在 */
async function ensureUploadDir(): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

/**
 * 修复 multer 中文文件名乱码。
 * multer 默认用 latin1 解码 Content-Disposition 中的 filename，
 * 但浏览器发送的是 UTF-8 编码，需要转换。
 */
function fixFilename(name: string): string {
  try {
    // 尝试将 latin1 误解码的字符串还原为 UTF-8
    return Buffer.from(name, 'latin1').toString('utf-8');
  } catch {
    return name;
  }
}

/**
 * 根据 fileId 获取上传文件的信息。
 */
export function getUploadedFile(fileId: string): { originalName: string; filePath: string; size: number; mimeType: string } | undefined {
  return uploadedFiles.get(fileId);
}

/**
 * 解析消息中的 [file:xxx] 引用，替换为文件路径信息。
 * 图片文件会转为 base64 data URL 供多模态 LLM 使用。
 * 返回处理后的消息文本、关联的文件路径列表和图片 data URL 列表。
 */
export function resolveFileReferences(message: string): { text: string; filePaths: string[]; imageUrls: string[] } {
  const filePaths: string[] = [];
  const imageUrls: string[] = [];

  const resolved = message.replace(/\[file:([a-f0-9-]+)\]\s*(.*)/g, (_match, fileId: string, filename: string) => {
    const file = uploadedFiles.get(fileId);
    if (file) {
      const ext = path.extname(file.originalName).toLowerCase();
      if ((CHAT_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
        // 图片文件：读取并转为 base64 data URL（同步标记，异步处理在调用方）
        imageUrls.push(file.filePath);
        return `[已上传图片] ${file.originalName}`;
      }
      filePaths.push(file.filePath);
      return `[已上传文件] ${file.originalName} (路径: ${file.filePath}, 大小: ${file.size} 字节)`;
    }
    return `[文件未找到] ${filename || fileId}`;
  });
  return { text: resolved, filePaths, imageUrls };
}

/**
 * 创建文件上传路由。
 */
export function createUploadRouter(): Router {
  const router = Router();

  // multer 配置：存到临时目录
  const storage = multer.diskStorage({
    destination: async (_req, _file, cb) => {
      await ensureUploadDir();
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      // 保留原始扩展名
      const originalName = fixFilename(file.originalname);
      const ext = path.extname(originalName);
      cb(null, `${randomUUID()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: CHAT_UPLOAD_MAX_FILE_BYTES },
  });

  /**
   * GET /api/chat/supported-formats — 上传/解析能力说明（供前端展示，非强制校验）
   */
  router.get('/supported-formats', (_req: Request, res: Response): void => {
    res.json({
      extensions: [...CHAT_SUGGESTED_EXTENSIONS],
      imageExtensions: [...CHAT_IMAGE_EXTENSIONS],
      maxFileBytes: CHAT_UPLOAD_MAX_FILE_BYTES,
    });
  });

  /**
   * POST /api/chat/upload — 上传文件
   */
  router.post('/upload', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
    try {
      const file = (req as any).file;
      if (!file) {
        res.json({ error: '未收到文件' });
        return;
      }

      // 修复中文文件名
      const originalName = fixFilename(file.originalname);

      const fileId = randomUUID();
      uploadedFiles.set(fileId, {
        originalName,
        filePath: file.path,
        size: file.size,
        mimeType: file.mimetype,
      });

      res.json({
        fileId,
        filename: originalName,
        size: file.size,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ error: `上传失败: ${message}` });
    }
  });

  return router;
}
