/**
 * 文件上传路由。
 * 接收前端上传的文件，保存到临时目录，返回 fileId 供后续消息引用。
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

/** 上传文件存储目录 */
const UPLOAD_DIR = path.join(os.tmpdir(), 'iceCoder-uploads');

/** 已上传文件的元数据缓存 */
const uploadedFiles = new Map<string, { originalName: string; filePath: string; size: number; mimeType: string }>();

/** 确保上传目录存在 */
async function ensureUploadDir(): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

/**
 * 根据 fileId 获取上传文件的路径。
 */
export function getUploadedFile(fileId: string): { originalName: string; filePath: string; size: number; mimeType: string } | undefined {
  return uploadedFiles.get(fileId);
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
      const ext = path.extname(file.originalname);
      cb(null, `${randomUUID()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  });

  /**
   * POST /api/chat/upload — 上传文件
   */
  router.post('/', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
    try {
      const file = (req as any).file;
      if (!file) {
        res.json({ error: '未收到文件' });
        return;
      }

      const fileId = randomUUID();
      uploadedFiles.set(fileId, {
        originalName: file.originalname,
        filePath: file.path,
        size: file.size,
        mimeType: file.mimetype,
      });

      res.json({
        fileId,
        filename: file.originalname,
        size: file.size,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.json({ error: `上传失败: ${message}` });
    }
  });

  return router;
}
