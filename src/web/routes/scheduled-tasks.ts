/**
 * 定时任务 API（挂载在 /api/scheduled-tasks）。
 *
 * GET    /           — 列出任务
 * POST   /           — 新建任务（自动创建专属会话）
 * PUT    /:id        — 编辑任务
 * DELETE /:id        — 删除任务（保留其会话）
 * POST   /:id/toggle — 启用 / 停用
 * POST   /:id/run    — 立即执行一次（不改变下次计划时间）
 */

import { Router, type Request, type Response } from 'express';
import {
  assertIntervalUnit,
  assertIntervalValue,
  type ScheduledTaskIntervalUnit,
  type ScheduledTaskStore,
  type ScheduledTaskUpdatePatch,
} from '../../session/scheduled-task-store.js';
import {
  SCHEDULED_TASK_BUSY_MESSAGE,
  type ScheduledTaskScheduler,
} from '../../session/scheduled-task-scheduler.js';

export interface ScheduledTasksRouterDeps {
  store: ScheduledTaskStore;
  scheduler: Pick<ScheduledTaskScheduler, 'reschedule' | 'runNow'>;
  createSession: (title: string) => Promise<{ id: string }>;
}

const NOT_FOUND_PREFIX = '定时任务不存在';
const VALIDATION_MESSAGES = ['任务名称不能为空', '任务提示词不能为空', '任务间隔必须是正整数', '任务间隔单位无效'];

function sendError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const status = message.startsWith(NOT_FOUND_PREFIX)
    ? 404
    : VALIDATION_MESSAGES.includes(message) ? 400
    : message === SCHEDULED_TASK_BUSY_MESSAGE ? 409 : 500;
  if (status === 500) console.error('[scheduled-tasks] 请求失败:', err);
  res.status(status).json({ success: false, error: message });
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asSkillList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
}

function parsePatch(body: Record<string, unknown>): ScheduledTaskUpdatePatch {
  const patch: ScheduledTaskUpdatePatch = {};
  if (body.name !== undefined) patch.name = asString(body.name);
  if (body.prompt !== undefined) patch.prompt = asString(body.prompt);
  if (body.skillFilenames !== undefined) patch.skillFilenames = asSkillList(body.skillFilenames);
  if (body.intervalValue !== undefined) patch.intervalValue = Number(body.intervalValue);
  if (body.intervalUnit !== undefined) patch.intervalUnit = body.intervalUnit as ScheduledTaskIntervalUnit;
  if (body.enabled !== undefined) patch.enabled = body.enabled === true;
  return patch;
}

export function createScheduledTasksRouter(deps: ScheduledTasksRouterDeps): Router {
  const { store, scheduler, createSession } = deps;
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    try {
      const tasks = await store.list();
      res.json({ success: true, tasks, now: Date.now() });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = asString(body.name).trim();
    const prompt = asString(body.prompt).trim();
    if (!name) { sendError(res, new Error('任务名称不能为空')); return; }
    if (!prompt) { sendError(res, new Error('任务提示词不能为空')); return; }
    try {
      // 先做完整校验再建会话，避免非法输入留下空会话。
      const draft = {
        name,
        prompt,
        skillFilenames: asSkillList(body.skillFilenames),
        intervalValue: Number(body.intervalValue),
        intervalUnit: body.intervalUnit as ScheduledTaskIntervalUnit,
        enabled: body.enabled !== false,
      };
      assertIntervalValue(draft.intervalValue);
      assertIntervalUnit(draft.intervalUnit);
      const session = await createSession(`定时任务：${name}`);
      const task = await store.create({ ...draft, sessionId: session.id });
      await scheduler.reschedule();
      res.json({ success: true, task });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const task = await store.update(String(req.params.id), parsePatch((req.body ?? {}) as Record<string, unknown>));
      await scheduler.reschedule();
      res.json({ success: true, task });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      await store.remove(String(req.params.id));
      await scheduler.reschedule();
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/toggle', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      const current = await store.get(id);
      if (!current) throw new Error(`${NOT_FOUND_PREFIX}: ${id}`);
      const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : !current.enabled;
      const task = await store.update(id, { enabled });
      await scheduler.reschedule();
      res.json({ success: true, task });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/run', async (req: Request, res: Response): Promise<void> => {
    try {
      const id = String(req.params.id);
      await scheduler.runNow(id);
      res.json({ success: true, task: await store.get(id) });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
