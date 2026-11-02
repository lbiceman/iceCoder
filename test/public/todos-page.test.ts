import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { readClassicWindowSource } from './classic-window-source.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABS_SOURCE = readClassicWindowSource(path.join(__dirname, '../../src/public/js/task-tabs.ts'));
const PAGE_SOURCE = readClassicWindowSource(path.join(__dirname, '../../src/public/js/todos-page.ts'));

let browser: Browser;
const openPages = new Set<Page>();

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

afterEach(async () => {
  await Promise.all([...openPages].map(async (page) => {
    try {
      if (!page.isClosed()) await page.close();
    } finally {
      openPages.delete(page);
    }
  }));
});

async function openTodos(todos: unknown[]): Promise<Page> {
  const page = await browser.newPage();
  openPages.add(page);
  await page.setContent('<!DOCTYPE html><html><body><div id="root"></div></body></html>');
  await page.evaluate((initial) => {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => (store.has(key) ? store.get(key) : null),
        setItem: (key: string, value: string) => { store.set(key, String(value)); },
        removeItem: (key: string) => { store.delete(key); },
      },
    });
    (window as any).__todos = initial;
    (window as any).__calls = [];
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init && init.method) || 'GET';
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      (window as any).__calls.push({ method, url, body });
      if (method === 'GET' && url === '/api/todos') {
        return new Response(JSON.stringify({ success: true, todos: (window as any).__todos }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST' && url === '/api/todos') {
        const todo = { id: 'new-id', text: body.text, createdAt: 1, doneAt: null, image: null };
        (window as any).__todos = [todo, ...(window as any).__todos];
        return new Response(JSON.stringify({ success: true, todo }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST' && /\/api\/todos\/[^/]+\/done$/.test(url)) {
        const id = url.split('/')[3];
        (window as any).__todos = (window as any).__todos.map((item: { id: string; doneAt: number | null }) => (
          item.id === id ? { ...item, doneAt: body.done ? 2 : null } : item
        ));
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: false, error: 'nope' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  }, todos);
  await page.addScriptTag({ content: TABS_SOURCE });
  await page.addScriptTag({ content: PAGE_SOURCE });
  await page.evaluate(() => {
    (window as any).TodosPage.render(document.getElementById('root'));
  });
  await page.locator('.todo-item, .skills-empty').first().waitFor();
  return page;
}

function calls(page: Page) {
  return page.evaluate(() => (window as any).__calls);
}

describe('待办页', () => {
  it('列出未完成和已完成，勾选、补记、放大截图，页签切到定时', async () => {
    const page = await openTodos([
      {
        id: 'a',
        text: '回头看报错',
        createdAt: 1,
        doneAt: null,
        image: { width: 1, height: 1, url: '/api/todos/a/image' },
      },
      {
        id: 'b',
        text: '已经做了',
        createdAt: 1,
        doneAt: 1,
        image: null,
      },
    ]);

    expect(await page.locator('.todo-count').innerText()).toBe('1 条未完成');
    expect(await page.locator('.todo-group-title').allInnerTexts()).toEqual(['未完成', '已完成']);
    expect(await page.locator('.todo-item').first().innerText()).toContain('回头看报错');
    expect(await page.locator('.todo-shot img').getAttribute('src')).toBe('/api/todos/a/image');

    await page.locator('.todo-shot').click();
    expect(await page.locator('.todo-lightbox').getAttribute('hidden')).toBeNull();
    await page.keyboard.press('Escape');
    expect(await page.locator('.todo-lightbox').getAttribute('hidden')).not.toBeNull();

    await page.locator('[data-todo-toggle="a"]').check();
    await expect.poll(() => calls(page)).toEqual(expect.arrayContaining([
      { method: 'POST', url: '/api/todos/a/done', body: { done: true } },
    ]));
    await expect.poll(() => page.locator('.todo-item.is-done').count()).toBe(2);

    await page.locator('.todo-compose input').fill('新的一条');
    await page.locator('.todo-compose button').click();
    await expect.poll(() => page.locator('.todo-item').first().innerText()).toContain('新的一条');
    expect(await page.locator('.todo-count').innerText()).toBe('1 条未完成');

    await page.locator('[data-task-tab="scheduled"]').click();
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/tasks');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('ice-task-tab'))).toBe('scheduled');
  });
});
