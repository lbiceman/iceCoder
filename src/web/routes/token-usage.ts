/**
 * GET /api/token-usage — 汇总各会话气泡上的 turnTokenUsage / usedModel。
 * 既有 day/week/month/byModel 供 ~tokens 弹框；series 供统计页图表。
 */

import { Router, type Request, type Response } from 'express';
import path from 'node:path';
import '../../cli/paths.js';
import { summarizeSessionTokenUsage } from '../token-usage-stats.js';

const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR!);

export function createTokenUsageRouter(): Router {
  const router = Router();
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const windows = await summarizeSessionTokenUsage(SESSIONS_DIR);
      res.json({ success: true, ...windows });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: err instanceof Error ? err.message : '统计失败',
      });
    }
  });
  return router;
}
