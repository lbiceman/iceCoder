/**
 * 技能文件管理 API（挂载在 /api/skills）。
 *
 * GET    /           — 列出所有技能
 * POST   /           — 创建简单技能 { folder?, name, content }
 * GET    /:filename  — 查看指定技能内容
 * PUT    /:filename  — 更新技能内容 { content }
 * DELETE /:filename  — 删除技能
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validatePath, PathTraversalError } from '../../memory/file-memory/memory-security.js';
import { getSkillRegistry } from '../../core/skill-registry.js';
import {
  SkillWriteError,
  createSkillFile,
  normalizeSkillFilename,
  readSkillFile,
  updateSkillContent,
} from '../../skills/skill-loader.js';
import '../../cli/paths.js';

const SKILLS_DIR = path.resolve(process.env.ICE_SKILLS_DIR!);

function sendSkillError(res: Response, error: unknown, action: string): void {
  if (error instanceof SkillWriteError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }
  if (error instanceof PathTraversalError) {
    res.status(403).json({ success: false, error: 'Path security violation' });
    return;
  }
  console.error(`[skills] ${action} failed:`, error);
  res.status(500).json({
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
  });
}

export function createSkillsRouter(): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const registry = getSkillRegistry();
      const skills = await registry.listSkills();
      res.json({ success: true, skills, total: skills.length });
    } catch (error) {
      console.error('[skills] List failed:', error);
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body ?? {}) as { folder?: unknown; name?: unknown; content?: unknown };
      const created = await createSkillFile(SKILLS_DIR, body);
      getSkillRegistry().invalidate();
      res.json({ success: true, ...created });
    } catch (error) {
      sendSkillError(res, error, 'Create');
    }
  });

  router.get('/:filename', async (req: Request, res: Response): Promise<void> => {
    const filename = normalizeSkillFilename(req.params.filename as string);
    if (!filename) {
      res.status(400).json({ success: false, error: 'Missing filename' });
      return;
    }

    try {
      const found = await readSkillFile(SKILLS_DIR, filename);
      if (!found) {
        res.status(404).json({ success: false, error: `Skill not found: ${filename}` });
        return;
      }
      res.json({
        success: true,
        filename,
        content: found.content,
        meta: found.meta,
      });
    } catch (e) {
      if (e instanceof PathTraversalError) {
        res.status(403).json({ success: false, error: 'Path security violation' });
        return;
      }
      res.status(500).json({ success: false, error: 'Failed to read skill' });
    }
  });

  router.put('/:filename', async (req: Request, res: Response): Promise<void> => {
    const filename = req.params.filename as string;
    try {
      const body = (req.body ?? {}) as { content?: unknown };
      const updated = await updateSkillContent(SKILLS_DIR, filename, body.content);
      getSkillRegistry().invalidate();
      res.json({ success: true, ...updated });
    } catch (error) {
      sendSkillError(res, error, 'Update');
    }
  });

  router.delete('/:filename', async (req: Request, res: Response): Promise<void> => {
    const filename = normalizeSkillFilename(req.params.filename as string);
    if (!filename) {
      res.status(400).json({ success: false, error: 'Missing filename' });
      return;
    }

    try {
      const filePath = validatePath(filename, SKILLS_DIR);
      await fs.access(filePath);
      await fs.unlink(filePath);
      getSkillRegistry().invalidate();
      console.log(`[skills] Deleted: ${filePath}`);
      res.json({ success: true, deleted: filename });
    } catch (e) {
      if (e instanceof PathTraversalError) {
        res.status(403).json({ success: false, error: 'Path security violation' });
        return;
      }
      res.status(404).json({ success: false, error: `Skill not found: ${filename}` });
    }
  });

  return router;
}
