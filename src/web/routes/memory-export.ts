/**
 * 记忆导出 API 路由。
 *
 * GET /api/memory/export — 将记忆文件打包为 gzip 压缩的二进制流下载。
 * GET /api/memory/stats  — 导出前预览：返回文件数和大小。
 *
 * 打包格式（自定义，零依赖）：
 * [4 bytes: file count (uint32 BE)]
 * For each file:
 *   [2 bytes: relative path length (uint16 BE)]
 *   [N bytes: relative path (utf-8), prefixed with "project/" or "user/"]
 *   [4 bytes: content length (uint32 BE)]
 *   [M bytes: content (utf-8)]
 * 整个 buffer 用 zlib.gzip 压缩后返回。
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

const DEFAULT_MEMORY_DIR = process.env.ICE_MEMORY_DIR || './data/memory-files';
const DEFAULT_USER_MEMORY_DIR = process.env.ICE_USER_MEMORY_DIR || './data/user-memory';

/** 递归扫描目录中的所有 .md 文件。 */
async function scanMdFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { recursive: true });
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.endsWith('.md')) {
        results.push(entry);
      }
    }
  } catch { /* 目录不存在 */ }
  return results;
}

/**
 * 将记忆文件打包为二进制 buffer。
 * project/ 和 user/ 前缀区分来源，导入时可还原到对应目录。
 */
async function packMemories(
  projectDir: string,
  userDir: string,
): Promise<{ buffer: Buffer; fileCount: number; totalBytes: number }> {
  const projectFiles = await scanMdFiles(projectDir);
  const userFiles = await scanMdFiles(userDir);

  const entries: Array<{ relativePath: string; content: Buffer }> = [];

  for (const f of projectFiles) {
    const content = await fs.readFile(path.join(projectDir, f));
    entries.push({ relativePath: 'project/' + f.replace(/\\/g, '/'), content });
  }
  for (const f of userFiles) {
    const content = await fs.readFile(path.join(userDir, f));
    entries.push({ relativePath: 'user/' + f.replace(/\\/g, '/'), content });
  }

  // 计算总大小
  let totalSize = 4;
  for (const e of entries) {
    const pathBuf = Buffer.from(e.relativePath, 'utf-8');
    totalSize += 2 + pathBuf.length + 4 + e.content.length;
  }

  const buffer = Buffer.alloc(totalSize);
  let offset = 0;

  buffer.writeUInt32BE(entries.length, offset);
  offset += 4;

  for (const e of entries) {
    const pathBuf = Buffer.from(e.relativePath, 'utf-8');
    buffer.writeUInt16BE(pathBuf.length, offset);
    offset += 2;
    pathBuf.copy(buffer, offset);
    offset += pathBuf.length;
    buffer.writeUInt32BE(e.content.length, offset);
    offset += 4;
    e.content.copy(buffer, offset);
    offset += e.content.length;
  }

  return { buffer, fileCount: entries.length, totalBytes: totalSize };
}

/** 创建记忆导出 API 路由。 */
export function createMemoryExportRouter(): Router {
  const router = Router();

  /** GET /export — 下载 gzip 压缩包 */
  router.get('/export', async (_req: Request, res: Response): Promise<void> => {
    try {
      const projectDir = path.resolve(DEFAULT_MEMORY_DIR);
      const userDir = path.resolve(DEFAULT_USER_MEMORY_DIR);
      const { buffer, fileCount, totalBytes } = await packMemories(projectDir, userDir);

      if (fileCount === 0) {
        res.status(404).json({ error: '没有可导出的记忆文件' });
        return;
      }

      const compressed = await gzipAsync(buffer);
      const date = new Date().toISOString().split('T')[0];
      const filename = 'icecoder-memory-' + date + '.gz';

      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
      res.setHeader('X-Memory-File-Count', String(fileCount));
      res.setHeader('X-Memory-Raw-Bytes', String(totalBytes));
      res.send(compressed);
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: '记忆导出失败: ' + message });
    }
  });

  /** GET /stats — 文件数和大小预览 */
  router.get('/stats', async (_req: Request, res: Response): Promise<void> => {
    try {
      const projectDir = path.resolve(DEFAULT_MEMORY_DIR);
      const userDir = path.resolve(DEFAULT_USER_MEMORY_DIR);
      const projectFiles = await scanMdFiles(projectDir);
      const userFiles = await scanMdFiles(userDir);

      res.json({
        success: true,
        project: { dir: projectDir, files: projectFiles.length },
        user: { dir: userDir, files: userFiles.length },
        total: projectFiles.length + userFiles.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '未知错误';
      res.status(500).json({ error: '统计失败: ' + message });
    }
  });

  return router;
}
