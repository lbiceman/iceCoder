/**
 * 技能文件管理 API（挂载在 /api/skills）。
 *
 * GET    /           — 列出所有技能
 * GET    /:filename  — 查看指定技能内容
 * DELETE /:filename  — 删除技能
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { validatePath, PathTraversalError } from '../../memory/file-memory/memory-security.js';
import { getSkillRegistry } from '../../core/skill-registry.js';
import {
  normalizeSkillFilename,
  readSkillFile,
} from '../../skills/skill-loader.js';
import '../../cli/paths.js';

const SKILLS_DIR = path.resolve(process.env.ICE_SKILLS_DIR!);

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
