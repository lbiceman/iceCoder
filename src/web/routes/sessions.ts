/**
 * 聊天消息持久化 API（多会话模式）。
 * 消息存储在 data/sessions/{id}.json，元数据索引在 data/sessions/index.json。
 * 用于 PC 端和移动端的聊天记录同步。
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'path';
import { parsePersistedPlan } from '../../memory/file-memory/execution-plan-fence.js';
// ExecutionPlan type removed (Phase 11)
import type { TaskCheckpoint } from '../../harness/checkpoint.js';
import { resolveEffectiveWorkspaceRoot } from '../../harness/session-workspace-store.js';
import { backfillPlaceholderSessionTitles } from '../session-title.js';

const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR ?? 'data/sessions');
const SESSION_ID = 'default';
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

// ---- 会话索引类型 ----

interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ---- 索引读写 ----

async function readSessionIndex(): Promise<SessionMeta[]> {
  try {
    const data = await fs.readFile(INDEX_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed as SessionMeta[];
  } catch { /* file missing or invalid */ }
  return [];
}

async function writeSessionIndex(index: SessionMeta[]): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8');
}

/**
 * 一次性迁移：把全局 `session-notes.md`（多会话改造前的旧布局）改名为
 * `default.session-notes.md`，避免新会话与旧会话共享同一份 fence。
 *
 * 仅当目标文件不存在时执行；幂等。
 */
async function migrateLegacySessionNotes(): Promise<void> {
  const legacy = path.join(SESSIONS_DIR, 'session-notes.md');
  const target = path.join(SESSIONS_DIR, `${SESSION_ID}.session-notes.md`);
  try {
    await fs.access(target);
    return; // 已迁移
  } catch { /* not exist, continue */ }
  try {
    await fs.access(legacy);
  } catch { return; /* nothing to migrate */ }
  try {
    await fs.rename(legacy, target);
    console.log('[sessions] migrated legacy session-notes.md → default.session-notes.md');
  } catch (err) {
    console.warn('[sessions] migrate legacy session-notes failed:', err);
  }
}

/** 旧安装仅有 default.json、index 为空时，引导写入 default 条目（用户主动删除 default 后不再自动恢复） */
async function ensureDefaultInIndex(): Promise<SessionMeta[]> {
  await migrateLegacySessionNotes();
  let index = await readSessionIndex();
  if (index.some(s => s.id === SESSION_ID)) return index;
  if (index.length > 0) return index;
  const defaultFile = path.join(SESSIONS_DIR, `${SESSION_ID}.json`);
  let messageCount = 0;
  try {
    const data = await fs.readFile(defaultFile, 'utf-8');
    const msgs = JSON.parse(data);
    if (Array.isArray(msgs)) messageCount = msgs.length;
  } catch { /* no default file yet */ }
  const now = Date.now();
  const meta: SessionMeta = {
    id: SESSION_ID,
    title: '默认会话',
    createdAt: now,
    updatedAt: now,
    messageCount,
  };
  index.unshift(meta);
  await writeSessionIndex(index);
  return index;
}

/** 进程/页面冷启动时选用最近更新的会话（index 按 updatedAt 降序）。 */
export async function bootstrapActiveSessionIdFromIndex(): Promise<string> {
  const index = await ensureDefaultInIndex();
  if (index.length === 0) return SESSION_ID;
  const sorted = [...index].sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0]!.id;
}

interface ChatMessage {
  role: string;
  content: string;
}

/** 确保目录存在 */
async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

async function buildWorkspaceIndex(sessionIds: string[]): Promise<{
  defaultWorkDir: string;
  workspaces: Record<string, string>;
}> {
  const defaultWorkDir = process.cwd();
  const workspaces: Record<string, string> = {};
  await Promise.all(
    sessionIds.map(async (id) => {
      const ws = await resolveEffectiveWorkspaceRoot(SESSIONS_DIR, id, defaultWorkDir);
      workspaces[id] = ws.workspaceRoot;
    }),
  );
  return { defaultWorkDir, workspaces };
}

/**
 * 读取指定 session 当前的执行计划。
 * 优先从 checkpoint 中取（最新），退化到 session-notes plan fence。
 * 找不到则返回 null。
 */
async function readSessionPlan(sessionId: string): Promise<any> {
  const checkpointPath = path.join(SESSIONS_DIR, `${sessionId}.checkpoint.json`);
  try {
    const raw = await fs.readFile(checkpointPath, 'utf-8');
    const cp = JSON.parse(raw) as TaskCheckpoint;
    if ((cp as any)?.plan) return (cp as any).plan;
  } catch {
    /* file missing or unparsable → fall through */
  }
  try {
    const notes = await fs.readFile(
      path.join(SESSIONS_DIR, `${sessionId}.session-notes.md`),
      'utf-8',
    );
    return parsePersistedPlan(notes);
  } catch {
    return null;
  }
}

/**
 * 删除会话相关文件族 + 通知 chat-ws 清理进程内缓存。
 *
 * 文件族（全部存在则删除，缺失静默忽略）：
 *  - `{id}.json`                 UI 展示消息
 *  - `{id}.structured.json`      LLM 结构化历史
 *  - `{id}.checkpoint.json`      TaskCheckpoint（断点恢复）
 *  - `{id}.workspace.json`       工作区锁定
 *  - `{id}.session-notes.md`     会话笔记（含 runtime / plan fence）
 */
type SessionCleanupHook = (sessionId: string) => void | Promise<void>;
let sessionCleanupHook: SessionCleanupHook | null = null;

export function registerSessionCleanupHook(hook: SessionCleanupHook | null): void {
  sessionCleanupHook = hook;
}

async function purgeSessionFiles(sessionId: string): Promise<void> {
  const suffixes = [
    '.json',
    '.structured.json',
    '.checkpoint.json',
    '.workspace.json',
    '.session-notes.md',
  ];
  await Promise.all(
    suffixes.map((suffix) =>
      fs.unlink(path.join(SESSIONS_DIR, `${sessionId}${suffix}`)).catch(() => {}),
    ),
  );
  if (sessionCleanupHook) {
    try {
      await sessionCleanupHook(sessionId);
    } catch (err) {
      console.warn('[sessions] cleanup hook failed:', err);
    }
  }
}

export function createSessionsRouter(): Router {
  const router = Router();

  /**
   * GET /api/sessions - 返回会话列表（读 index.json）
   */
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    let index = await ensureDefaultInIndex();
    index = await backfillPlaceholderSessionTitles(index);
    const { defaultWorkDir, workspaces } = await buildWorkspaceIndex(index.map(s => s.id));
    const activeSessionId = await bootstrapActiveSessionIdFromIndex();
    res.json({ sessions: index, defaultWorkDir, workspaces, activeSessionId });
  });

  /**
   * POST /api/sessions - 创建新会话
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const title = (req.body?.title as string) || '新会话';
    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    const meta: SessionMeta = { id, title, createdAt: now, updatedAt: now, messageCount: 0 };
    const index = await ensureDefaultInIndex();
    index.unshift(meta);
    await writeSessionIndex(index);
    // 创建空消息文件
    await ensureDir();
    await fs.writeFile(path.join(SESSIONS_DIR, `${id}.json`), '[]', 'utf-8');
    res.json({ success: true, session: meta });
  });

  /**
   * GET /api/sessions/workspace/:id - 获取会话有效工作目录
   * 使用 /workspace/:id 避免与 /:id 动态段冲突；须在 /:id 之前注册。
   */
  router.get('/workspace/:id', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const id = String(req.params.id || SESSION_ID);
    const defaultWorkDir = process.cwd();
    const workspace = await resolveEffectiveWorkspaceRoot(SESSIONS_DIR, id, defaultWorkDir);
    res.json(workspace);
  });

  /**
   * PATCH /api/sessions/:id - 重命名会话
   */
  router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
    const sessionId = String(req.params.id);
    const { title } = req.body as { title?: string };
    if (!title) { res.status(400).json({ error: 'title required' }); return; }
    const index = await readSessionIndex();
    const entry = index.find(s => s.id === sessionId);
    if (!entry) { res.status(404).json({ error: 'not found' }); return; }
    entry.title = title;
    entry.updatedAt = Date.now();
    await writeSessionIndex(index);
    res.json({ success: true, session: entry });
  });

  /**
   * DELETE /api/sessions/:id - 删除会话（含 default）
   *
   * 注意：调用方应先在客户端切到其它会话（前端 `chat-session-store.deleteSession`
   * 会先发 `switch_session`），否则 chat-ws 进程内 `activeSessionId` 仍指向被删 id。
   */
  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const sessionId = String(req.params.id);
    let index = await readSessionIndex();
    const entry = index.find(s => s.id === sessionId);
    if (!entry) { res.status(404).json({ error: 'not found' }); return; }
    index = index.filter(s => s.id !== sessionId);
    await writeSessionIndex(index);
    await purgeSessionFiles(sessionId);
    res.json({ success: true });
  });

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
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const sessionId = String(req.params.id || SESSION_ID);
    const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
    try {
      const data = await fs.readFile(file, 'utf-8');
      res.json({ messages: JSON.parse(data) });
    } catch {
      res.json({ messages: [] });
    }
  });

  /**
   * PUT /api/sessions/:id - 保存会话消息（前端全量覆盖）
   */
  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    const sessionId = String(req.params.id || SESSION_ID);
    const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
    const { messages } = req.body as { messages: ChatMessage[] };
    await ensureDir();
    await fs.writeFile(file, JSON.stringify(messages || []), 'utf-8');
    res.json({ success: true });
  });

  return router;
}
