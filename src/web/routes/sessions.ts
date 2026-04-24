/**
 * 聊天消息持久化 API（单会话模式）。
 * 固定会话 ID 'default'，消息存储在 data/sessions/default.json。
 * 用于 PC 端和移动端的聊天记录同步。
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'path';

const SESSIONS_DIR = path.resolve('data/sessions');
const SESSION_ID = 'default';
const SESSION_FILE = path.join(SESSIONS_DIR, `${SESSION_ID}.json`);

interface ChatMessage {
  role: string;
  content: string;
}

/** 确保目录存在 */
async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

export function createSessionsRouter(): Router {
  const router = Router();

  /**
   * GET /api/sessions/:id - 获取会话消息
   */
  router.get('/:id', async (_req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    try {
      const data = await fs.readFile(SESSION_FILE, 'utf-8');
      res.json({ messages: JSON.parse(data) });
    } catch {
      res.json({ messages: [] });
    }
  });

  /**
   * PUT /api/sessions/:id - 保存会话消息（前端 ~clear 后全量覆盖）
   */
  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const { messages } = req.body as { messages: ChatMessage[] };
    await ensureDir();
    await fs.writeFile(SESSION_FILE, JSON.stringify(messages || []), 'utf-8');
    res.json({ success: true });
  });

  return router;
}
