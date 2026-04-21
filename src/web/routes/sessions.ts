/**
 * 聊天会话持久化 API。
 * 将会话列表和消息存储在服务端 data/sessions/ 目录，
 * 实现 PC 端和移动端的聊天记录同步。
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'path';

const SESSIONS_DIR = path.resolve('data/sessions');
const SESSION_LIST_FILE = path.join(SESSIONS_DIR, '_list.json');

interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
}

interface ChatMessage {
  role: string;
  content: string;
}

/** 确保目录存在 */
async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

/** 读取会话列表 */
async function readSessionList(): Promise<SessionMeta[]> {
  try {
    const data = await fs.readFile(SESSION_LIST_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/** 写入会话列表 */
async function writeSessionList(list: SessionMeta[]): Promise<void> {
  await ensureDir();
  await fs.writeFile(SESSION_LIST_FILE, JSON.stringify(list), 'utf-8');
}

/** 会话消息文件路径 */
function sessionFile(id: string): string {
  // 防止路径穿越
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

const ACTIVE_SESSION_FILE = path.join(SESSIONS_DIR, '_active.txt');

/** 设置活跃 session（由 chat 路由调用），持久化到文件 */
export async function setActiveSession(id: string): Promise<void> {
  await ensureDir();
  await fs.writeFile(ACTIVE_SESSION_FILE, id, 'utf-8');
}

/** 获取活跃 session，从文件读取 */
export async function getActiveSession(): Promise<string | null> {
  try {
    return (await fs.readFile(ACTIVE_SESSION_FILE, 'utf-8')).trim();
  } catch {
    return null;
  }
}

export function createSessionsRouter(): Router {
  const router = Router();

  /**
   * GET /api/sessions - 获取会话列表
   */
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const list = await readSessionList();
    const activeId = await getActiveSession();
    res.json({ sessions: list, activeSessionId: activeId });
  });

  /**
   * GET /api/sessions/:id - 获取某个会话的消息
   */
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    try {
      const data = await fs.readFile(sessionFile(req.params.id as string), 'utf-8');
      res.json({ messages: JSON.parse(data) });
    } catch {
      res.json({ messages: [] });
    }
  });

  /**
   * PUT /api/sessions/:id - 保存某个会话的消息 + 更新列表
   */
  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const { messages, title } = req.body as { messages: ChatMessage[]; title?: string };

    await ensureDir();
    await fs.writeFile(sessionFile(id), JSON.stringify(messages || []), 'utf-8');

    // 更新会话列表
    const list = await readSessionList();
    const idx = list.findIndex(s => s.id === id);
    const meta: SessionMeta = {
      id,
      title: title || '新对话',
      updatedAt: Date.now(),
    };
    if (idx >= 0) {
      list[idx] = meta;
    } else {
      list.unshift(meta);
    }
    await writeSessionList(list);

    res.json({ success: true });
  });

  /**
   * DELETE /api/sessions/:id - 删除会话
   */
  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;

    // 删除消息文件
    try { await fs.unlink(sessionFile(id)); } catch { /* ignore */ }

    // 从列表移除
    const list = await readSessionList();
    const filtered = list.filter(s => s.id !== id);
    await writeSessionList(filtered);

    res.json({ success: true });
  });

  return router;
}
