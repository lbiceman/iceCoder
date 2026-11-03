import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TodoStore } from '../../src/session/todo-store.js';
import { TODO_NOT_FOUND_MESSAGE } from '../../src/session/todo-store.js';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('待办存储', () => {
  let dir: string;
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((item) => fs.rm(item, { recursive: true, force: true })));
  });

  async function createStore(now = () => 1_000) {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-todos-'));
    dirs.push(dir);
    return new TodoStore(path.join(dir, 'todos.json'), path.join(dir, 'files'), now);
  }

  it('文字待办按未完成在前、新的在前排列，勾完再打开', async () => {
    let clock = 1_000;
    const store = await createStore(() => clock);
    const first = await store.create({ text: '先记的' });
    clock = 2_000;
    const second = await store.create({ text: '后记的' });
    expect((await store.list()).map((item) => item.text)).toEqual(['后记的', '先记的']);

    clock = 3_000;
    const done = await store.setDone(second.id, true);
    expect(done.doneAt).toBe(3_000);
    expect((await store.list()).map((item) => item.id)).toEqual([first.id, second.id]);

    const reopened = await store.setDone(second.id, false);
    expect(reopened.doneAt).toBeNull();
    expect((await store.list()).map((item) => item.id)).toEqual([second.id, first.id]);
  });

  it('截图写成 png 文件，删除时一并去掉', async () => {
    const store = await createStore();
    const todo = await store.create({ text: '', png: PNG_1x1, width: 1, height: 1 });
    expect(todo.image).toEqual({ file: `${todo.id}.png`, width: 1, height: 1 });
    const file = await store.imageAbsPath(todo.id);
    expect(file).toBeTruthy();
    expect(await fs.readFile(file!)).toEqual(PNG_1x1);

    await store.remove(todo.id);
    expect(await store.list()).toEqual([]);
    await expect(fs.access(file!)).rejects.toThrow();
    await expect(store.remove(todo.id)).rejects.toThrow(TODO_NOT_FOUND_MESSAGE);
  });

  it('认不出的文件先备份，再按空列表继续', async () => {
    const store = await createStore(() => 50);
    const file = path.join(dir, 'todos.json');
    await fs.writeFile(file, '{', 'utf-8');
    expect(await store.list()).toEqual([]);
    const backup = await fs.readdir(dir);
    expect(backup.some((name) => name.startsWith('todos.json.broken-'))).toBe(true);
  });
});
