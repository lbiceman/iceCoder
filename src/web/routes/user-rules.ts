/**
 * 用户级全局规则 API（挂载在 /api/user-rules）。
 *
 * GET    /      — 列出规则、限额与预计每轮 token
 * POST   /      — 新增 { content, enabled? }
 * PUT    /:id   — 修改 { content?, enabled? }
 * DELETE /:id   — 删除
 */

import { Router, type Request, type Response } from 'express';
import {
  USER_RULES_LIMITS,
  type UserRule,
  UserRuleValidationError,
  enabledUserRulesChars,
  estimateUserRulesTokens,
  userRulesOverheadTokens,
} from '../../prompts/user-rules.js';
import { UserRuleNotFoundError, UserRulesStore } from '../../prompts/user-rules-store.js';

function summary(rules: UserRule[]) {
  return {
    rules,
    limits: USER_RULES_LIMITS,
    enabledChars: enabledUserRulesChars(rules),
    estimatedTokens: estimateUserRulesTokens(rules),
    overheadTokens: userRulesOverheadTokens(),
  };
}

function sendError(res: Response, err: unknown, action: string): void {
  if (err instanceof UserRuleValidationError) {
    res.status(400).json({ success: false, error: err.message });
    return;
  }
  if (err instanceof UserRuleNotFoundError) {
    res.status(404).json({ success: false, error: err.message });
    return;
  }
  console.error(`[user-rules] ${action} failed:`, err);
  res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Unknown error' });
}

export function createUserRulesRouter(store: UserRulesStore = new UserRulesStore()): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json({ success: true, ...summary(await store.list()) });
    } catch (err) {
      sendError(res, err, 'List');
    }
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const rule = await store.create(req.body ?? {});
      res.json({ success: true, rule, ...summary(await store.list()) });
    } catch (err) {
      sendError(res, err, 'Create');
    }
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const rule = await store.update(req.params.id as string, req.body ?? {});
      res.json({ success: true, rule, ...summary(await store.list()) });
    } catch (err) {
      sendError(res, err, 'Update');
    }
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      await store.remove(req.params.id as string);
      res.json({ success: true, ...summary(await store.list()) });
    } catch (err) {
      sendError(res, err, 'Delete');
    }
  });

  return router;
}
