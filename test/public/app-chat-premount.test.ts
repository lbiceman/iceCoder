import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/app.ts'),
  'utf-8',
));

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

async function bootApp(page: Page, hash: string, setupRequired: boolean): Promise<void> {
  await page.setContent(
    '<!DOCTYPE html><html><body><div id="app"><main id="page-container"></main></div></body></html>',
  );
  await page.evaluate(({ hash, setupRequired }) => {
    history.replaceState(null, '', hash);
    const store: Record<string, string> = {};
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = String(v); },
        removeItem: (k: string) => { delete store[k]; },
      },
    });
    const calls: unknown[][] = [];
    (window as any).__calls = calls;
    (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    (window as any).fetch = async (url: string) => {
      if (url === '/api/config') return { ok: true, json: async () => ({ setupRequired, providers: [] }) };
      throw new Error(`unexpected fetch ${url}`);
    };
    (window as any).ChatSessionSidebar = { create() {} };
    let chatMounted = false;
    (window as any).ChatPage = {
      render(root: HTMLElement) {
        chatMounted = true;
        calls.push(['chat.render', root.dataset.pageRoot, root.style.display]);
      },
      onActivate() { calls.push(['chat.onActivate']); },
      isMounted() { return chatMounted; },
    };
    (window as any).TasksPage = {
      render() { calls.push(['tasks.render']); },
      destroy() {},
    };
    (window as any).SettingsPage = { render() { calls.push(['settings.render']); }, onActivate() {}, onDeactivate() {} };
  }, { hash, setupRequired });
  await page.addScriptTag({ content: APP_SOURCE });
}

describe('桌面端首屏不是聊天页', () => {
  it('首屏是任务页：后台挂载聊天页（隐藏），保证 WS 连上、侧栏会话列表能实时刷新', async () => {
    const page = await browser.newPage();
    try {
      await bootApp(page, '#/tasks', false);
      await expect.poll(() => page.evaluate(() => (window as any).__calls)).toEqual([
        ['tasks.render'],
        ['chat.render', 'chat', 'none'],
      ]);
      expect(await page.evaluate(() => document.body.dataset.page)).toBe('tasks');
    } finally {
      await page.close();
    }
  });

  it('之后切回聊天页只激活，不重复挂载', async () => {
    const page = await browser.newPage();
    try {
      await bootApp(page, '#/tasks', false);
      await expect.poll(() => page.evaluate(() => (window as any).__calls.length)).toBe(2);
      await page.evaluate(() => { (window as any).AppRouter.navigate('chat'); });
      expect(await page.evaluate(() => (window as any).__calls.slice(2))).toEqual([['chat.onActivate']]);
      expect(await page.evaluate(() => document.body.dataset.page)).toBe('chat');
    } finally {
      await page.close();
    }
  });

  it('需要先配置模型时不提前挂载聊天页', async () => {
    const page = await browser.newPage();
    try {
      await bootApp(page, '#/settings', true);
      await expect.poll(() => page.evaluate(() => (window as any).__calls)).toEqual([['settings.render']]);
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => (window as any).__calls)).toEqual([['settings.render']]);
    } finally {
      await page.close();
    }
  });
});
