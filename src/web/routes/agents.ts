/**
 * 用户 Agent API（挂载在 /api/agents）。
 *
 * GET    /        — 列出
 * POST   /        — 创建 { id, name, description?, prompt, tools }
 * GET    /:id     — 读取
 * PUT    /:id     — 更新名称、说明、提示词、工具
 * DELETE /:id     — 删除
 */

import { Router, type Request, type Response } from 'express';

import { AgentWriteError } from '../../agents/agent-profile.js';
import {
  createAgent,
  deleteAgent,
  getAgentsDir,
  listAgents,
  readAgent,
  updateAgent,
} from '../../agents/agent-store.js';

function sendError(res: Response, error: unknown, action: string): void {
  if (error instanceof AgentWriteError) {
    res.status(error.status).json({ success: false, error: error.message });
    return;
  }
  console.error(`[agents] ${action} failed:`, error);
  res.status(500).json({
    success: false,
    error: error instanceof Error ? error.message : 'Unknown error',
  });
}

export function createAgentsRouter(): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const agents = await listAgents(getAgentsDir());
      res.json({ success: true, agents, total: agents.length });
    } catch (error) {
      sendError(res, error, 'List');
    }
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const agent = await createAgent(req.body ?? {}, getAgentsDir());
      res.json({ success: true, agent });
    } catch (error) {
      sendError(res, error, 'Create');
    }
  });

  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id || '');
    try {
      const agent = await readAgent(id, getAgentsDir());
      if (!agent) {
        res.status(404).json({ success: false, error: `Agent 不存在：${id}` });
        return;
      }
      res.json({ success: true, agent });
    } catch (error) {
      sendError(res, error, 'Read');
    }
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const agent = await updateAgent(String(req.params.id || ''), req.body ?? {}, getAgentsDir());
      res.json({ success: true, agent });
    } catch (error) {
      sendError(res, error, 'Update');
    }
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id || '');
    try {
      await deleteAgent(id, getAgentsDir());
      res.json({ success: true, deleted: id });
    } catch (error) {
      sendError(res, error, 'Delete');
    }
  });

  return router;
}
