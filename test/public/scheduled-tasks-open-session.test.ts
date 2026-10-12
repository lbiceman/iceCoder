import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/scheduled-tasks-page.ts'),
  'utf-8',
));

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

describe('任务页「打开会话」', () => {
  it('跳转前让侧栏展开该任务会话所在的分组', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<!DOCTYPE html><html><body><div id="root"></div></body></html>');
      await page.evaluate(() => {
        const task = {
          id: 'task-a', name: '解析图片', prompt: 'p', skillFilenames: [], images: [], files: [],
          intervalValue: 1, intervalUnit: 'day', once: false, sessionId: 'sess-old', enabled: true,
          createdAt: 1, updatedAt: 1, lastRunAt: null, nextRunAt: null, lastStatus: 'idle', lastError: null,
        };
        const calls: string[][] = [];
        (window as any).__calls = calls;
        (window as any).fetch = async (url: string, init?: { method?: string }) => {
          if (url === '/api/scheduled-tasks' && (!init || !init.method)) {
            return { ok: true, json: async () => ({ success: true, tasks: [task] }) };
          }
          if (url === '/api/scheduled-tasks/task-a/session' && init?.method === 'POST') {
            return { ok: true, json: async () => ({ success: true, task, sessionReady: true }) };
          }
          throw new Error(`unexpected fetch ${url}`);
        };
        (window as any).ChatSessionStore = { fetchSessions(cb: () => void) { calls.push(['fetchSessions']); cb(); } };
        (window as any).ChatSessionSidebar = { revealSession(id: string) { calls.push(['reveal', id]); } };
        (window as any).AppRouter = { navigateWorkChat(id: string) { calls.push(['navigate', id]); } };
      });
      await page.addScriptTag({ content: PAGE_SOURCE });
      await page.evaluate(() => { (window as any).ScheduledTasksPage.render(document.getElementById('root')); });
      await page.locator('[data-action="open-session"]').click();
      await expect.poll(() => page.evaluate(() => (window as any).__calls)).toEqual([
        ['fetchSessions'],
        ['reveal', 'sess-old'],
        ['navigate', 'sess-old'],
      ]);
    } finally {
      await page.close();
    }
  });

  async function renderWith(page: import('playwright').Page, sessionId: string, sessionReady: boolean) {
    await page.setContent('<!DOCTYPE html><html><body><div id="root"></div></body></html>');
    await page.evaluate(({ sessionId, sessionReady }) => {
      const task = {
        id: 'task-a', name: '解析图片', prompt: 'p', skillFilenames: [], images: [], files: [],
        intervalValue: 1, intervalUnit: 'day', once: false, sessionId, enabled: true,
        createdAt: 1, updatedAt: 1, lastRunAt: null, nextRunAt: null, lastStatus: 'idle', lastError: null,
      };
      const calls: unknown[][] = [];
      (window as any).__calls = calls;
      (window as any).fetch = async (url: string, init?: { method?: string }) => {
        if (url === '/api/scheduled-tasks' && (!init || !init.method)) {
          return { ok: true, json: async () => ({ success: true, tasks: [task] }) };
        }
        if (url === '/api/scheduled-tasks/task-a/session' && init?.method === 'POST') {
          calls.push(['session-api']);
          return { ok: true, json: async () => ({ success: true, task, sessionReady }) };
        }
        throw new Error(`unexpected fetch ${url}`);
      };
      (window as any).Notification = { info(msg: string) { calls.push(['info', msg]); }, error(msg: string) { calls.push(['error', msg]); } };
      (window as any).ChatSessionStore = { fetchSessions(cb: () => void) { calls.push(['fetchSessions']); cb(); } };
      (window as any).ChatSessionSidebar = { revealSession(id: string) { calls.push(['reveal', id]); } };
      (window as any).AppRouter = { navigateWorkChat(id: string) { calls.push(['navigate', id]); } };
    }, { sessionId, sessionReady });
    await page.addScriptTag({ content: PAGE_SOURCE });
    await page.evaluate(() => { (window as any).ScheduledTasksPage.render(document.getElementById('root')); });
  }

  it('还没执行过的任务：按钮置灰并提示执行时创建会话', async () => {
    const page = await browser.newPage();
    try {
      await renderWith(page, '', false);
      const btn = page.locator('[data-action="open-session"]');
      await expect.poll(() => btn.isDisabled()).toBe(true);
      expect(await btn.getAttribute('title')).toBe('该任务还没有会话，执行时会自动创建');
      await btn.click({ force: true });
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => (window as any).__calls)).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('专属会话已被删除：不新建、不跳转，只提示', async () => {
    const page = await browser.newPage();
    try {
      await renderWith(page, 'sess-deleted', false);
      await page.locator('[data-action="open-session"]').click();
      await expect.poll(() => page.evaluate(() => (window as any).__calls)).toEqual([
        ['session-api'],
        ['info', '该任务还没有会话，执行时会自动创建'],
      ]);
    } finally {
      await page.close();
    }
  });
});
