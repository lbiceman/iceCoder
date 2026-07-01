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

interface UploadedFileMeta {
  originalName: string;
  filePath: string;
  size: number;
  mimeType: string;
}

/**
 * 已上传文件元数据缓存上限（FIFO）。超过后淘汰最旧条目并删除其临时文件，
 * 避免 Map 无界增长 + tmp 目录文件堆积。可用 ICE_UPLOAD_CACHE_MAX 覆盖。
 */
const DEFAULT_UPLOAD_CACHE_MAX = 200;

function getUploadCacheMax(): number {
  const raw = process.env.ICE_UPLOAD_CACHE_MAX;
  if (raw == null || raw === '') return DEFAULT_UPLOAD_CACHE_MAX;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_UPLOAD_CACHE_MAX;
}

/** 已上传文件的元数据缓存（插入顺序即 FIFO 淘汰顺序） */
const uploadedFiles = new Map<string, UploadedFileMeta>();

/** 后台删除临时文件（best-effort，不抛错） */
function unlinkTempFileBestEffort(filePath: string): void {
  void fs.unlink(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err?.code !== 'ENOENT') {
      console.warn('[upload] 清理临时文件失败:', filePath, err?.message ?? err);
    }
  });
}

/** 登记上传文件，超出上限时 FIFO 淘汰最旧条目并删除其临时文件。 */
function registerUploadedFile(fileId: string, meta: UploadedFileMeta): void {
  uploadedFiles.set(fileId, meta);
  const max = getUploadCacheMax();
  while (uploadedFiles.size > max) {
    const oldestKey = uploadedFiles.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const evicted = uploadedFiles.get(oldestKey);
    uploadedFiles.delete(oldestKey);
    if (evicted) unlinkTempFileBestEffort(evicted.filePath);
  }
}

/** 确保上传目录存在 */
async function ensureUploadDir(): Promise<void> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
}

/** 启动时清理 tmp 目录中的陈旧残留文件（上次进程遗留），best-effort。 */
async function sweepStaleUploads(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(UPLOAD_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries.map(async (name) => {
      const full = path.join(UPLOAD_DIR, name);
      try {
        const stat = await fs.stat(full);
        if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
          await fs.unlink(full);
        }
      } catch {
        /* 忽略单个文件的 stat/unlink 失败 */
      }
    }),
  );
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

/** 清空上传缓存并删除其临时文件（优雅关闭时调用）。 */
export function purgeAllUploadedFiles(): void {
  for (const meta of uploadedFiles.values()) {
    unlinkTempFileBestEffort(meta.filePath);
  }
  uploadedFiles.clear();
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

  void ensureUploadDir().then(() => sweepStaleUploads()).catch(() => {});

  // multer 配置：存到临时目录
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
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
  router.post('/upload', (req: Request, res: Response): void => {
    upload.single('file')(req, res, (err: unknown) => {
      if (err) {
        let message: string;
        let status = 400;
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            message = `文件超过 ${CHAT_UPLOAD_MAX_FILE_BYTES / (1024 * 1024)}MB 上限`;
            status = 413;
          } else {
            message = err.message;
          }
        } else {
          message = err instanceof Error ? err.message : String(err);
          status = 500;
        }
        res.status(status).json({ error: `上传失败: ${message}` });
        return;
      }

      void (async () => {
        try {
          const file = (req as { file?: { originalname: string; path: string; size: number; mimetype: string } }).file;
          if (!file) {
            res.status(400).json({ error: '未收到文件' });
            return;
          }

          const originalName = fixFilename(file.originalname);
          const fileId = randomUUID();
          registerUploadedFile(fileId, {
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
        } catch (handlerErr) {
          const message = handlerErr instanceof Error ? handlerErr.message : String(handlerErr);
          res.status(500).json({ error: `上传失败: ${message}` });
        }
      })();
    });
  });

  return router;
}
