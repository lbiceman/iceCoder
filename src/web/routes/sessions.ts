/**
 * 聊天消息持久化 API（多会话模式）。
 * 消息存储在 data/sessions/{id}.json，元数据索引在 data/sessions/index.json。
 * 用于 PC 端和移动端的聊天记录同步。
 */

import { Router, type Request, type Response } from 'express';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'path';
import '../../cli/paths.js';
import { parsePersistedPlan } from '../../memory/file-memory/execution-plan-fence.js';
// ExecutionPlan type removed (Phase 11)
import type { TaskCheckpoint } from '../../harness/checkpoint.js';
import { resolveEffectiveWorkspaceRoot } from '../../harness/session-workspace-store.js';
import { getDefaultWorkDir } from '../../cli/paths.js';
import { backfillPlaceholderSessionTitles } from '../session-title.js';
import {
  resolveSessionImageFile,
} from '../images-cache.js';
import { readStructuredMessagesFile } from '../session-structured-io.js';
import {
  collectWorkspaceRoots,
  readToolTraceDiffIndex,
  resolveToolDiffForSession,
} from '../session-tool-trace-diffs.js';
import { isSafeSessionId } from '../session-id-guard.js';
import { resolveBootstrapActiveSessionId } from '../last-active-session.js';
import {
  DEFAULT_SESSION_ID,
  loadSessionIndex,
  mutateSessionIndex,
  type SessionMeta,
} from '../session-index-store.js';
import { getTaskQueueManager } from '../../session/task-queue.js';
import {
  readSessionBgTasks,
  syncSessionBgTasksFromManager,
} from '../../session/bg-tasks-store.js';
import { loadCheckpointIndex } from '../../harness/intent-checkpoint-store.js';
import { readUiSessionMessages } from '../../harness/intent-checkpoint-capture.js';
import { purgeSessionDiskFiles } from '../session-file-purge.js';
import { buildShellCollabActiveIndex } from '../../session/shell-collab-store.js';

const SESSIONS_DIR = path.resolve(process.env.ICE_SESSIONS_DIR!);
const SESSION_ID = DEFAULT_SESSION_ID;

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

/** 对账磁盘 `{id}.json` 后返回 index；空 index 且无会话文件时才引导 default。 */
async function ensureDefaultInIndex(): Promise<SessionMeta[]> {
  await migrateLegacySessionNotes();
  return loadSessionIndex();
}

/** 进程/页面冷启动时选用最近工作的会话（见 last-active-session.ts）。 */
export async function bootstrapActiveSessionIdFromIndex(): Promise<string> {
  const index = await ensureDefaultInIndex();
  return resolveBootstrapActiveSessionId(index);
}

/** 会话列表第一项（与侧栏/抽屉渲染顺序一致）。扫码连入默认订阅此项。 */
export async function readFirstSessionIdFromIndex(): Promise<string> {
  const index = await ensureDefaultInIndex();
  return index[0]?.id || SESSION_ID;
}

interface ChatMessage {
  role: string;
  content: string;
  id?: string;
  images?: string[];
  sentAt?: number;
  completedAt?: number;
}

/** 确保目录存在 */
async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

async function buildWorkspaceIndex(sessionIds: string[]): Promise<{
  defaultWorkDir: string;
  workspaces: Record<string, string>;
}> {
  const defaultWorkDir = getDefaultWorkDir();
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
const CHECKPOINT_PREVIEW_MAX = 140;

export interface CheckpointTimelineEntry {
  messageId: string;
  userMessageTime: number | null;
  createdAt: string;
  preview: string;
  isCursor: boolean;
}

/** 读取 Intent Checkpoint 索引，附带用户消息摘要（供状态快照 Tab 时间轴）。 */
export async function readCheckpointTimeline(sessionId: string): Promise<{
  cursorMessageId: string | null;
  entries: CheckpointTimelineEntry[];
}> {
  const index = await loadCheckpointIndex(SESSIONS_DIR, sessionId);
  const uiMessages = await readUiSessionMessages(SESSIONS_DIR, sessionId);
  const uiById = new Map(uiMessages.filter((m) => m.id).map((m) => [m.id!, m]));

  const entries: CheckpointTimelineEntry[] = index.entries.map((entry) => {
    const ui = uiById.get(entry.messageId);
    const raw = typeof ui?.content === 'string' ? ui.content.trim() : '';
    const preview = raw.length > CHECKPOINT_PREVIEW_MAX
      ? `${raw.slice(0, CHECKPOINT_PREVIEW_MAX)}…`
      : raw;
    return {
      messageId: entry.messageId,
      userMessageTime: entry.userMessageTime,
      createdAt: entry.createdAt,
      preview: preview || '（无消息摘要）',
      isCursor: entry.messageId === index.cursorMessageId,
    };
  });

  entries.sort((a, b) => {
    const ta = a.userMessageTime ?? Date.parse(a.createdAt) ?? 0;
    const tb = b.userMessageTime ?? Date.parse(b.createdAt) ?? 0;
    if (ta !== tb) return ta - tb;
    return a.createdAt.localeCompare(b.createdAt);
  });

  return { cursorMessageId: index.cursorMessageId, entries };
}

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
 *  - `{id}/analysis|subtasks|artifacts` 异步子代理分析工作区
 */
type SessionCleanupHook = (sessionId: string) => void | Promise<void>;
let sessionCleanupHook: SessionCleanupHook | null = null;

export function registerSessionCleanupHook(hook: SessionCleanupHook | null): void {
  sessionCleanupHook = hook;
}

type SessionListLiveSync = {
  getRunStates: () => unknown[];
  notifyIndexUpdated: () => void;
};

let sessionListLiveSync: SessionListLiveSync | null = null;

/** 由 chat-ws 入口注入：REST 列表带上运行态圆点，CRUD 后通知 PC/手机刷新。 */
export function registerSessionListLiveSync(sync: SessionListLiveSync | null): void {
  sessionListLiveSync = sync;
}

async function purgeSessionFiles(sessionId: string): Promise<void> {
  // 先停 harness / 取消刷盘定时器，避免删文件后又被异步写入 resurrect
  if (sessionCleanupHook) {
    try {
      await sessionCleanupHook(sessionId);
    } catch (err) {
      console.warn('[sessions] cleanup hook failed:', err);
    }
  }
  await purgeSessionDiskFiles(SESSIONS_DIR, sessionId);
}

function rejectUnsafeSessionId(res: Response, sessionId: string): boolean {
  if (isSafeSessionId(sessionId)) return false;
  res.status(400).json({ error: 'invalid session id' });
  return true;
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
    const sessionIds = index.map((s) => s.id);
    const [{ defaultWorkDir, workspaces }, shellCollabActive, activeSessionId] = await Promise.all([
      buildWorkspaceIndex(sessionIds),
      buildShellCollabActiveIndex(sessionIds, SESSIONS_DIR),
      bootstrapActiveSessionIdFromIndex(),
    ]);
    res.json({
      sessions: index,
      defaultWorkDir,
      workspaces,
      shellCollabActive,
      activeSessionId,
      sessionRunStates: sessionListLiveSync ? sessionListLiveSync.getRunStates() : [],
    });
  });

  /**
   * POST /api/sessions - 创建新会话
   */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const title = (req.body?.title as string) || '新会话';
    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    const meta: SessionMeta = { id, title, createdAt: now, updatedAt: now, messageCount: 0 };
    await mutateSessionIndex(async (index) => {
      index.unshift(meta);
      await ensureDir();
      await fs.writeFile(path.join(SESSIONS_DIR, `${id}.json`), '[]', 'utf-8');
      return index;
    });
    sessionListLiveSync?.notifyIndexUpdated();
    res.json({ success: true, session: meta });
  });

  /**
   * GET /api/sessions/workspace/:id - 获取会话有效工作目录
   * 使用 /workspace/:id 避免与 /:id 动态段冲突；须在 /:id 之前注册。
   */
  router.get('/workspace/:id', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const id = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, id)) return;
    const defaultWorkDir = getDefaultWorkDir();
    const workspace = await resolveEffectiveWorkspaceRoot(SESSIONS_DIR, id, defaultWorkDir);
    res.json(workspace);
  });

  /**
   * PATCH /api/sessions/:id - 重命名会话
   */
  router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
    const sessionId = String(req.params.id);
    if (rejectUnsafeSessionId(res, sessionId)) return;
    const { title } = req.body as { title?: string };
    if (!title) { res.status(400).json({ error: 'title required' }); return; }
    let entry: SessionMeta | undefined;
    await mutateSessionIndex((index) => {
      entry = index.find(s => s.id === sessionId);
      if (!entry) return index;
      entry.title = title;
      entry.updatedAt = Date.now();
      return index;
    });
    if (!entry) { res.status(404).json({ error: 'not found' }); return; }
    sessionListLiveSync?.notifyIndexUpdated();
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
    if (rejectUnsafeSessionId(res, sessionId)) return;
    let found = false;
    await mutateSessionIndex(async (index) => {
      found = index.some(s => s.id === sessionId);
      if (!found) return index;
      // 先摘掉消息文件，避免并发 GET 对账时把已删会话补回 index
      await fs.unlink(path.join(SESSIONS_DIR, `${sessionId}.json`)).catch(() => {});
      return index.filter(s => s.id !== sessionId);
    });
    if (!found) { res.status(404).json({ error: 'not found' }); return; }
    await purgeSessionFiles(sessionId);
    sessionListLiveSync?.notifyIndexUpdated();
    res.json({ success: true });
  });

  /**
   * GET /api/sessions/:id/images/:fileName - 会话 imagesCache 图片（UI 刷新后展示）
   */
  router.get('/:id/images/:fileName', async (req: Request, res: Response): Promise<void> => {
    const sessionId = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, sessionId)) return;
    const fileName = String(req.params.fileName || '');
    const abs = resolveSessionImageFile(sessionId, fileName);
    if (!abs) {
      res.status(400).json({ error: 'invalid image path' });
      return;
    }
    try {
      await fs.access(abs);
    } catch {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(abs);
  });

  /**
   * GET /api/sessions/:id/plan - 获取执行计划（feature flag 关时返回 plan=null）
   * 必须在 /:id 之前注册，避免被通配 :id 路由抢占。
   */
  router.get('/:id/plan', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const id = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, id)) return;
    const plan = await readSessionPlan(id);
    res.json({ plan });
  });

  /**
   * GET /api/sessions/:id/checkpoints - Intent Checkpoint 时间轴（状态快照 Tab）
   */
  router.get('/:id/checkpoints', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const id = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, id)) return;
    const timeline = await readCheckpointTimeline(id);
    res.json(timeline);
  });

  /**
   * GET /api/sessions/:id/tool-trace-diffs - toolCallId → diff 索引（不受 structured 压缩影响）
   */
  router.get('/:id/tool-trace-diffs', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const sessionId = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, sessionId)) return;
    const index = await readToolTraceDiffIndex(SESSIONS_DIR, sessionId);
    res.json({ index });
  });

  /**
   * GET /api/sessions/:id/tool-diff - 按 toolCallId / 相对路径解析 diff（含工作区读文件回退）
   */
  router.get('/:id/tool-diff', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const sessionId = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, sessionId)) return;
    const toolCallId = typeof req.query.toolCallId === 'string' ? req.query.toolCallId : '';
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    const toolName = typeof req.query.toolName === 'string' ? req.query.toolName : 'write_file';
    const structuredRaw = await readStructuredMessagesFile(SESSIONS_DIR, sessionId);
    const structured = structuredRaw?.map((m) => ({
      role: m.role,
      toolCallId: m.toolCallId,
      content: typeof m.content === 'string' ? m.content : undefined,
    }));
    const roots = await collectWorkspaceRoots(SESSIONS_DIR, sessionId, getDefaultWorkDir());
    const workspaceOverride = typeof req.query.workspaceRoot === 'string'
      ? req.query.workspaceRoot.trim()
      : '';
    let safeOverride: string | undefined;
    if (workspaceOverride) {
      const resolvedOverride = path.resolve(workspaceOverride);
      const inKnownRoots = roots.some((r) => path.resolve(r) === resolvedOverride);
      if (inKnownRoots) {
        safeOverride = resolvedOverride;
      } else {
        try {
          const st = await fs.stat(resolvedOverride);
          if (st.isDirectory()) safeOverride = resolvedOverride;
        } catch {
          /* ignore invalid override */
        }
      }
    }
    const diffSource = await resolveToolDiffForSession({
      sessionsDir: SESSIONS_DIR,
      sessionId,
      defaultWorkDir: getDefaultWorkDir(),
      toolCallId: toolCallId || undefined,
      relPath: relPath || undefined,
      toolName,
      structured,
      workspaceRootOverride: safeOverride,
    });
    if (!diffSource) {
      res.json({ diffSource: null });
      return;
    }
    res.json({ diffSource });
  });

  /**
   * GET /api/sessions/:id/bg-tasks - 当前会话 running 后台 shell 任务（跨端同步）
   */
  router.get('/:id/bg-tasks', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const sessionId = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, sessionId)) return;
    try {
      const workspace = await resolveEffectiveWorkspaceRoot(SESSIONS_DIR, sessionId, getDefaultWorkDir());
      const tasks = await syncSessionBgTasksFromManager(SESSIONS_DIR, sessionId, workspace.workspaceRoot);
      res.json({ ok: true, tasks });
    } catch {
      const tasks = await readSessionBgTasks(SESSIONS_DIR, sessionId);
      res.json({ ok: true, tasks });
    }
  });

  /**
   * GET /api/sessions/:id/task-queue - 返回待执行队列
   */
  router.get('/:id/task-queue', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const sessionId = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, sessionId)) return;
    const items = await getTaskQueueManager(SESSIONS_DIR).list(sessionId);
    res.json({ ok: true, items });
  });

  /**
   * DELETE /api/sessions/:id/task-queue/:taskId - 删除排队任务
   */
  router.delete('/:id/task-queue/:taskId', async (req: Request, res: Response): Promise<void> => {
    const sessionId = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, sessionId)) return;
    const taskId = String(req.params.taskId || '').trim();
    if (!taskId) {
      res.status(400).json({ ok: false, error: 'taskId required' });
      return;
    }
    const manager = getTaskQueueManager(SESSIONS_DIR);
    const removed = await manager.removeById(sessionId, taskId);
    if (!removed) {
      res.status(404).json({ ok: false, error: 'not found' });
      return;
    }
    const items = await manager.list(sessionId);
    res.json({ ok: true, items });
    try {
      const { notifyTaskQueueUpdated } = await import('../chat-ws.js');
      void notifyTaskQueueUpdated(sessionId);
    } catch {
      /* WS 未挂载时忽略广播 */
    }
  });

  /**
   * GET /api/sessions/:id/structured - harness 结构化消息（UI diff 历史还原）
   */
  router.get('/:id/structured', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const sessionId = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, sessionId)) return;
    const messages = await readStructuredMessagesFile(SESSIONS_DIR, sessionId);
    res.json({ messages: messages ?? [] });
  });

  /**
   * GET /api/sessions/:id - 获取会话消息
   */
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const sessionId = String(req.params.id || SESSION_ID);
    if (rejectUnsafeSessionId(res, sessionId)) return;
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
    if (rejectUnsafeSessionId(res, sessionId)) return;
    const file = path.join(SESSIONS_DIR, `${sessionId}.json`);
    const { messages } = req.body as { messages: ChatMessage[] };
    await ensureDir();
    await fs.writeFile(file, JSON.stringify(messages || []), 'utf-8');
    res.json({ success: true });
  });

  return router;
}
