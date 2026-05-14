/**
 * 聊天消息持久化 API（单会话模式）。
 * 固定会话 ID 'default'，消息存储在 data/sessions/default.json。
 * 用于 PC 端和移动端的聊天记录同步。
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import path from 'path';
import { parsePersistedPlan } from '../../memory/file-memory/execution-plan-fence.js';
import type { ExecutionPlan } from '../../types/execution-plan.js';
import type { TaskCheckpoint } from '../../harness/checkpoint.js';

/** 与 chat-ws.ts 使用相同解析规则，避免读写的不是同一个 default.json */
const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR ?? 'data/sessions');
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

/**
 * 读取指定 session 当前的执行计划。
 * 优先从 checkpoint 中取（最新），退化到 session-notes plan fence。
 * 找不到则返回 null。
 */
async function readSessionPlan(sessionId: string): Promise<ExecutionPlan | null> {
  const checkpointPath = path.join(SESSIONS_DIR, `${sessionId}.checkpoint.json`);
  try {
    const raw = await fs.readFile(checkpointPath, 'utf-8');
    const cp = JSON.parse(raw) as TaskCheckpoint;
    if (cp?.plan) return cp.plan;
  } catch {
    /* file missing or unparsable → fall through */
  }
  try {
    const notes = await fs.readFile(path.join(SESSIONS_DIR, 'session-notes.md'), 'utf-8');
    return parsePersistedPlan(notes);
  } catch {
    return null;
  }
}

export function createSessionsRouter(): Router {
  const router = Router();

  /**
   * GET /api/sessions/:id/plan - 获取执行计划（feature flag 关时返回 plan=null）
   * 必须在 /:id 之前注册，避免被通配 :id 路由抢占。
   */
  router.get('/:id/plan', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const id = String(req.params.id || SESSION_ID);
    const plan = await readSessionPlan(id);
    res.json({ plan });
  });

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
