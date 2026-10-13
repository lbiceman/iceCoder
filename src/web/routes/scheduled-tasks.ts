/**
 * 定时任务 API（挂载在 /api/scheduled-tasks）。
 *
 * GET    /                     — 列出任务
 * POST   /                     — 新建任务（不建会话，首次执行时才创建；images/files 见 scheduled-task-attachments）
 * PUT    /:id                  — 编辑任务
 * DELETE /:id                  — 删除任务（保留其会话，删除任务图片与文件附件）
 * POST   /:id/toggle           — 启用 / 停用
 * POST   /:id/run              — 立即执行一次（不改变下次计划时间）
 * POST   /:id/session          — 打开专属会话前调用：返回 sessionReady，没有会话时不新建
 * GET    /:id/images/:imageId  — 任务图片（编辑表单预览）
 *
 * 增删改逻辑在 scheduled-task-service，与聊天工具 scheduled_task 共用。
 */

import { Router, type Request, type Response } from 'express';
import { SCHEDULED_TASK_BUSY_MESSAGE } from '../../session/scheduled-task-scheduler.js';
import {
  MONTH_DAYS_EMPTY_MESSAGE,
  MONTH_DAYS_INVALID_MESSAGE,
  SCHEDULE_KIND_INVALID_MESSAGE,
  TIME_OF_DAY_INVALID_MESSAGE,
  WEEKDAYS_EMPTY_MESSAGE,
  WEEKDAYS_INVALID_MESSAGE,
} from '../../session/scheduled-task-store.js';
import {
  ATTACHMENT_EXPIRED_MESSAGE,
  ATTACHMENT_INVALID_MESSAGE,
} from '../scheduled-task-attachments.js';
import {
  SCHEDULED_TASK_NOT_FOUND_PREFIX,
  createScheduledTaskService,
  type ScheduledTaskServiceDeps,
} from '../scheduled-task-service.js';

export interface ScheduledTasksRouterDeps extends ScheduledTaskServiceDeps {
  sessionExists: (sessionId: string) => Promise<boolean>;
}

const VALIDATION_MESSAGES = [
  '任务名称不能为空',
  '任务提示词不能为空',
  '任务间隔必须是正整数',
  '任务间隔单位无效',
  SCHEDULE_KIND_INVALID_MESSAGE,
  TIME_OF_DAY_INVALID_MESSAGE,
  WEEKDAYS_EMPTY_MESSAGE,
  WEEKDAYS_INVALID_MESSAGE,
  MONTH_DAYS_EMPTY_MESSAGE,
  MONTH_DAYS_INVALID_MESSAGE,
  ATTACHMENT_EXPIRED_MESSAGE,
  ATTACHMENT_INVALID_MESSAGE,
];

function sendError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const status = message.startsWith(SCHEDULED_TASK_NOT_FOUND_PREFIX)
    ? 404
    : VALIDATION_MESSAGES.includes(message) ? 400
    : message === SCHEDULED_TASK_BUSY_MESSAGE ? 409 : 500;
  if (status === 500) console.error('[scheduled-tasks] 请求失败:', err);
  res.status(status).json({ success: false, error: message });
}

export function createScheduledTasksRouter(deps: ScheduledTasksRouterDeps): Router {
  const { store, sessionExists } = deps;
  const service = createScheduledTaskService(deps);
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    try {
      const tasks = await service.list();
      res.json({ success: true, tasks });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const task = await service.create((req.body ?? {}) as Record<string, unknown>);
      res.json({ success: true, task });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.put('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      const task = await service.update(String(req.params.id), (req.body ?? {}) as Record<string, unknown>);
      res.json({ success: true, task });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    try {
      await service.remove(String(req.params.id));
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/toggle', async (req: Request, res: Response): Promise<void> => {
    try {
      const enabled = typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined;
      const task = await service.toggle(String(req.params.id), enabled);
      res.json({ success: true, task });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/run', async (req: Request, res: Response): Promise<void> => {
    try {
      const task = await service.runNow(String(req.params.id));
      res.json({ success: true, task });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/session', async (req: Request, res: Response): Promise<void> => {
    try {
      const task = await service.get(String(req.params.id));
      const sessionReady = task.sessionId !== '' && await sessionExists(task.sessionId);
      res.json({ success: true, task, sessionReady });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id/images/:imageId', async (req: Request, res: Response): Promise<void> => {
    try {
      const task = await store.get(String(req.params.id));
      const image = task?.images.find((img) => img.id === String(req.params.imageId));
      if (!image) {
        res.status(404).json({ success: false, error: 'not found' });
        return;
      }
      res.setHeader('Cache-Control', 'private, max-age=86400');
      // 数据目录可能在 ~/.iceCoder 这类点目录下，sendFile 默认会把整条路径当隐藏文件拒绝。
      res.sendFile(image.path, { dotfiles: 'allow' }, (err) => {
        if (err && !res.headersSent) res.status(404).json({ success: false, error: 'not found' });
      });
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
