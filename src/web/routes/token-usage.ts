/**
 * GET /api/token-usage — 汇总 token-usage.jsonl（与会话无关）。
 * day/week/month/byModel 供 ~tokens 弹框；series 供统计页图表。
 */

import { Router, type Request, type Response } from 'express';
import '../../cli/paths.js';
import { summarizeTokenUsage } from '../token-usage-stats.js';

export function createTokenUsageRouter(): Router {
  const router = Router();
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const windows = await summarizeTokenUsage();
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
