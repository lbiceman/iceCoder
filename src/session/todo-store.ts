/**
 * 待办清单。和定时任务分开存：一条是短文本，可带一张截图，勾完就结束，不会到点执行。
 * 截图落在 filesRoot/{id}.png，清单里只记文件名、宽和高。
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../memory/file-memory/atomic-write.js';

export const TODO_NOT_FOUND_MESSAGE = '待办不存在';

const TODO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTodoId(id: string): boolean {
  return TODO_ID.test(id);
}

export interface TodoImage {
  /** 相对 filesRoot 的文件名，只能是 `{id}.png`。 */
  file: string;
  width: number;
  height: number;
}

export interface TodoItem {
  id: string;
  text: string;
  createdAt: number;
  doneAt: number | null;
  image: TodoImage | null;
}

export interface TodoCreateInput {
  text: string;
  png?: Buffer | null;
  width?: number;
  height?: number;
}

interface PersistedTodos {
  version: 1;
  todos: TodoItem[];
}

function imageName(id: string): string {
  return `${id}.png`;
}

function compareTodo(a: TodoItem, b: TodoItem): number {
  const ad = a.doneAt == null ? 0 : 1;
  const bd = b.doneAt == null ? 0 : 1;
  if (ad !== bd) return ad - bd;
  return b.createdAt - a.createdAt;
}

function cloneTodo(todo: TodoItem): TodoItem {
  return {
    id: todo.id,
    text: todo.text,
    createdAt: todo.createdAt,
    doneAt: todo.doneAt,
    image: todo.image ? { ...todo.image } : null,
  };
}

function normalizeLoaded(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Partial<TodoItem>;
  if (typeof item.id !== 'string' || !isTodoId(item.id)) return null;
  if (typeof item.text !== 'string') return null;
  if (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt)) return null;
  const doneAt = typeof item.doneAt === 'number' && Number.isFinite(item.doneAt) ? item.doneAt : null;
  let image: TodoImage | null = null;
  if (item.image && typeof item.image === 'object') {
    const file = item.image.file;
    const width = item.image.width;
    const height = item.image.height;
    if (
      file === imageName(item.id)
      && typeof width === 'number' && width > 0
      && typeof height === 'number' && height > 0
    ) {
      image = { file, width, height };
    }
  }
  return { id: item.id, text: item.text, createdAt: item.createdAt, doneAt, image };
}

export class TodoStore {
  private todos: TodoItem[] | null = null;
  private opTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly filesRoot: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const run = this.opTail.then(op, op);
    this.opTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureLoaded(): Promise<TodoItem[]> {
    if (this.todos) return this.todos;
    this.todos = await this.readFromDisk();
    return this.todos;
  }

  private async readFromDisk(): Promise<TodoItem[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    let parsed: PersistedTodos | null = null;
    try {
      parsed = JSON.parse(raw) as PersistedTodos;
    } catch {
      parsed = null;
    }
    if (parsed?.version === 1 && Array.isArray(parsed.todos)) {
      return parsed.todos.map(normalizeLoaded).filter((item): item is TodoItem => item != null);
    }
    await this.backupUnreadable();
    return [];
  }

  private async backupUnreadable(): Promise<void> {
    const backup = `${this.filePath}.broken-${this.now()}`;
    try {
      await fs.copyFile(this.filePath, backup);
      console.warn(`[todos] 待办文件无法识别，已按空列表加载，原文件备份到 ${backup}`);
    } catch (err) {
      console.warn('[todos] 待办文件无法识别且备份失败:', err);
    }
  }

  private async persist(todos: TodoItem[]): Promise<void> {
    const payload: PersistedTodos = { version: 1, todos };
    await writeFileAtomic(this.filePath, JSON.stringify(payload, null, 2), 'utf-8');
    this.todos = todos;
  }

  async list(): Promise<TodoItem[]> {
    return this.runExclusive(async () => {
      const todos = await this.ensureLoaded();
      return todos.slice().sort(compareTodo).map(cloneTodo);
    });
  }

  async get(id: string): Promise<TodoItem | undefined> {
    return this.runExclusive(async () => {
      const todos = await this.ensureLoaded();
      const found = todos.find((item) => item.id === id);
      return found ? cloneTodo(found) : undefined;
    });
  }

  async create(input: TodoCreateInput): Promise<TodoItem> {
    return this.runExclusive(async () => {
      const todos = await this.ensureLoaded();
      const id = randomUUID();
      const png = input.png && input.png.length > 0 ? input.png : null;
      let image: TodoImage | null = null;
      if (png) {
        const width = input.width ?? 0;
        const height = input.height ?? 0;
        if (width < 1 || height < 1) throw new Error('截图格式无效');
        image = { file: imageName(id), width, height };
        await writeFileAtomic(path.join(this.filesRoot, image.file), png);
      }
      const item: TodoItem = {
        id,
        text: input.text,
        createdAt: this.now(),
        doneAt: null,
        image,
      };
      try {
        await this.persist(todos.concat(item));
      } catch (err) {
        if (image) await fs.unlink(path.join(this.filesRoot, image.file)).catch(() => {});
        throw err;
      }
      return cloneTodo(item);
    });
  }

  async setDone(id: string, done: boolean): Promise<TodoItem> {
    return this.runExclusive(async () => {
      const todos = await this.ensureLoaded();
      const index = todos.findIndex((item) => item.id === id);
      if (index < 0) throw new Error(TODO_NOT_FOUND_MESSAGE);
      const current = todos[index]!;
      const updated: TodoItem = {
        ...current,
        doneAt: done ? (current.doneAt ?? this.now()) : null,
      };
      const next = todos.slice();
      next[index] = updated;
      await this.persist(next);
      return cloneTodo(updated);
    });
  }

  async remove(id: string): Promise<void> {
    return this.runExclusive(async () => {
      const todos = await this.ensureLoaded();
      const current = todos.find((item) => item.id === id);
      if (!current) throw new Error(TODO_NOT_FOUND_MESSAGE);
      await this.persist(todos.filter((item) => item.id !== id));
      if (current.image) {
        await fs.unlink(path.join(this.filesRoot, current.image.file)).catch(() => {});
      }
    });
  }

  /** 清单里记下的那张图。文件名不是 `{id}.png` 时当作没有。 */
  async imageAbsPath(id: string): Promise<string | null> {
    return this.runExclusive(async () => {
      const todos = await this.ensureLoaded();
      const current = todos.find((item) => item.id === id);
      if (!current?.image || current.image.file !== imageName(id)) return null;
      const abs = path.resolve(this.filesRoot, current.image.file);
      const rel = path.relative(path.resolve(this.filesRoot), abs);
      if (rel !== current.image.file) return null;
      try {
        await fs.access(abs);
      } catch {
        return null;
      }
      return abs;
    });
  }
}
