/**
 * 记忆文件管理 API 路由。
 *
 * GET    /api/memory/files              — 列出所有记忆文件（项目级 + 用户级）
 * DELETE /api/memory/files/:filename    — 删除指定记忆文件
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanMemoryFiles } from '../../memory/file-memory/memory-scanner.js';
import { validatePath, PathTraversalError } from '../../memory/file-memory/memory-security.js';

/** 默认记忆目录 */
const DEFAULT_MEMORY_DIR = process.env.ICE_MEMORY_DIR || 'data/memory-files';
const DEFAULT_USER_MEMORY_DIR = process.env.ICE_USER_MEMORY_DIR || 'data/user-memory';

/**
 * 创建记忆文件管理 API 路由。
 */
export function createMemoryFilesRouter(): Router {
  const router = Router();

  /**
   * GET / — 列出所有记忆文件
   */
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const projDir = path.resolve(DEFAULT_MEMORY_DIR);
      const userDir = path.resolve(DEFAULT_USER_MEMORY_DIR);

      // 扫描项目级和用户级记忆
      const projMemories = await scanMemoryFiles(projDir, 200);
      const userMemories = await scanMemoryFiles(userDir, 50);

      // 合并去重（用户级标记 level）
      const seenFilenames = new Set(projMemories.map(m => m.filename));
      const allMemories = [
        ...projMemories.map(m => ({
          filename: m.filename,
          type: m.type || 'unknown',
          description: m.description || '',
          confidence: m.confidence,
          recallCount: m.recallCount,
          source: m.source || '',
          tags: m.tags,
          level: 'project' as const,
          modifiedAt: new Date(m.mtimeMs).toISOString(),
        })),
        ...userMemories
          .filter(m => !seenFilenames.has(m.filename))
          .map(m => ({
            filename: m.filename,
            type: m.type || 'unknown',
            description: m.description || '',
            confidence: m.confidence,
            recallCount: m.recallCount,
            source: m.source || '',
            tags: m.tags,
            level: 'user' as const,
            modifiedAt: new Date(m.mtimeMs).toISOString(),
          })),
      ];

      res.json({ success: true, files: allMemories, total: allMemories.length });
    } catch (error) {
      console.error('[memory-files] List failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /:filename — 查看指定记忆文件的完整内容
   */
  router.get('/:filename', async (req: Request, res: Response): Promise<void> => {
    const filename = req.params.filename as string;

    if (!filename) {
      res.status(400).json({ success: false, error: 'Missing filename' });
      return;
    }

    const projDir = path.resolve(DEFAULT_MEMORY_DIR);
    const userDir = path.resolve(DEFAULT_USER_MEMORY_DIR);

    for (const dir of [projDir, userDir]) {
      try {
        const filePath = validatePath(filename, dir);
        const content = await fs.readFile(filePath, 'utf-8');
        const level = dir === userDir ? 'user' : 'project';
        res.json({ success: true, filename, level, content });
        return;
      } catch (e) {
        if (e instanceof PathTraversalError) {
          res.status(403).json({ success: false, error: 'Path security violation' });
          return;
        }
      }
    }

    res.status(404).json({ success: false, error: `Memory file not found: ${filename}` });
  });

  /**
   * DELETE /:filename — 删除指定记忆文件
   */
  router.delete('/:filename', async (req: Request, res: Response): Promise<void> => {
    const filename = req.params.filename as string;

    if (!filename) {
      res.status(400).json({ success: false, error: 'Missing filename' });
      return;
    }

    // 禁止删除索引文件
    if (filename === 'MEMORY.md') {
      res.status(403).json({ success: false, error: 'Cannot delete MEMORY.md index file' });
      return;
    }

    const projDir = path.resolve(DEFAULT_MEMORY_DIR);
    const userDir = path.resolve(DEFAULT_USER_MEMORY_DIR);

    // 尝试在项目级和用户级目录中查找并删除
    for (const dir of [projDir, userDir]) {
      try {
        const filePath = validatePath(filename, dir);
        await fs.access(filePath);
        await fs.unlink(filePath);
        console.log(`[memory-files] Deleted: ${filePath}`);
        res.json({ success: true, deleted: filename });
        return;
      } catch (e) {
        if (e instanceof PathTraversalError) {
          res.status(403).json({ success: false, error: 'Path security violation' });
          return;
        }
        // 文件不在此目录，继续查找下一个
      }
    }

    res.status(404).json({ success: false, error: `Memory file not found: ${filename}` });
  });

  return router;
}
