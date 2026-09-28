import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WELCOME_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/chat-welcome.ts'),
  'utf-8',
));

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

async function loadWelcome(): Promise<Page> {
  const page = await browser.newPage();
  openPages.add(page);
  await page.route('**/api/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: [], maxTokens: 0 }),
    });
  });
  await page.setContent('<!DOCTYPE html><html><body><div id="dash"></div></body></html>');
  await page.addScriptTag({ content: WELCOME_SOURCE });
  await page.evaluate(() => {
    (window as any).AppIcon = {
      html: () => '',
      hydrate: () => {},
    };
    const dash = document.getElementById('dash')!;
    dash.innerHTML = (window as any).ChatWelcome.buildDashboardMarkup(false);
  });
  return page;
}

describe('欢迎页门控卡片', () => {
  it('已连接时显示门控就绪，不展示停时验收', async () => {
    const page = await loadWelcome();
    const result = await page.evaluate(() => {
      const dash = document.getElementById('dash')!;
      (window as any).ChatWelcome.syncDashboard(dash, {
        connectionState: 'connected',
        supervisorMode: 'off',
      });
      const value = document.querySelector('[data-welcome-pipeline]') as HTMLElement | null;
      const label = value?.parentElement?.querySelector('.chat-welcome-stat-label');
      return {
        label: label?.textContent ?? '',
        value: value?.textContent ?? '',
        title: value?.getAttribute('title') ?? '',
      };
    });

    expect(result).toEqual({
      label: '验收门控',
      value: '就绪',
      title: '工具执行前的审批：allow / confirm / deny',
    });
  });

  it('未连接或待配置时显示未激活', async () => {
    const page = await loadWelcome();
    const result = await page.evaluate(() => {
      const dash = document.getElementById('dash')!;
      const welcome = (window as any).ChatWelcome;
      welcome.syncDashboard(dash, { connectionState: 'disconnected' });
      const disconnected = (document.querySelector('[data-welcome-pipeline]') as HTMLElement).textContent;
      welcome.syncDashboard(dash, { connectionState: 'connected', setupRequired: true });
      const setup = (document.querySelector('[data-welcome-pipeline]') as HTMLElement).textContent;
      return { disconnected, setup };
    });

    expect(result).toEqual({ disconnected: '未激活', setup: '未激活' });
  });
});
