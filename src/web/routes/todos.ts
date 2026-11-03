/**
 * 待办 API（挂载在 /api/todos）。
 *
 * GET    /            — 未完成在前，同组里新的在前
 * POST   /            — { text, image? } image 为 PNG data URL；只有图、没有字也可以
 * POST   /:id/done    — { done: boolean }
 * DELETE /:id
 * GET    /:id/image   — 这条待办的截图
 */

import { promises as fs } from 'node:fs';
import { Router, type Request, type Response } from 'express';
import { TODO_NOT_FOUND_MESSAGE, isTodoId, type TodoItem, type TodoStore } from '../../session/todo-store.js';
import {
  TODO_EMPTY_MESSAGE,
  TODO_IMAGE_INVALID_MESSAGE,
  TODO_IMAGE_LARGE_MESSAGE,
  TODO_TEXT_LONG_MESSAGE,
  decodeTodoPng,
  normalizeTodoText,
} from '../todo-image.js';

export interface TodoView {
  id: string;
  text: string;
  createdAt: number;
  doneAt: number | null;
  image: { width: number; height: number; url: string } | null;
}

const VALIDATION_MESSAGES = [
  TODO_EMPTY_MESSAGE,
  TODO_TEXT_LONG_MESSAGE,
  TODO_IMAGE_INVALID_MESSAGE,
  TODO_IMAGE_LARGE_MESSAGE,
  'done 须为 boolean',
];

function toView(todo: TodoItem): TodoView {
  return {
    id: todo.id,
    text: todo.text,
    createdAt: todo.createdAt,
    doneAt: todo.doneAt,
    image: todo.image
      ? { width: todo.image.width, height: todo.image.height, url: `/api/todos/${todo.id}/image` }
      : null,
  };
}

function sendError(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const status = message === TODO_NOT_FOUND_MESSAGE
    ? 404
    : VALIDATION_MESSAGES.includes(message) ? 400 : 500;
  if (status === 500) console.error('[todos] 请求失败:', err);
  res.status(status).json({ success: false, error: message });
}

export function createTodosRouter(store: TodoStore): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const todos = (await store.list()).map(toView);
      res.json({ success: true, todos });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const decoded = decodeTodoPng(body.image);
      const text = normalizeTodoText(body.text, decoded != null);
      const todo = await store.create({
        text,
        png: decoded?.png ?? null,
        width: decoded?.width,
        height: decoded?.height,
      });
      res.json({ success: true, todo: toView(todo) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.post('/:id/done', async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    if (!isTodoId(id)) {
      res.status(404).json({ success: false, error: TODO_NOT_FOUND_MESSAGE });
      return;
    }
    if (typeof req.body?.done !== 'boolean') {
      res.status(400).json({ success: false, error: 'done 须为 boolean' });
      return;
    }
    try {
      const todo = await store.setDone(id, req.body.done);
      res.json({ success: true, todo: toView(todo) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    if (!isTodoId(id)) {
      res.status(404).json({ success: false, error: TODO_NOT_FOUND_MESSAGE });
      return;
    }
    try {
      await store.remove(id);
      res.json({ success: true });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get('/:id/image', async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id);
    if (!isTodoId(id)) {
      res.status(404).end();
      return;
    }
    try {
      const file = await store.imageAbsPath(id);
      if (!file) {
        res.status(404).end();
        return;
      }
      const png = await fs.readFile(file);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(png);
    } catch (err) {
      sendError(res, err);
    }
  });

  return router;
}
