import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDEBAR_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/chat-session-sidebar.ts'),
  'utf-8',
));
const STORE_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/chat-session-store.ts'),
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

const PAYLOAD = {
  sessions: [
    { id: 'n1', title: '周报整理', updatedAt: 1 },
    { id: 'n2', title: 'nettyCloud 接入', updatedAt: 1 },
    { id: 'n3', title: 'English Agent Page', updatedAt: 1 },
    { id: 't1', title: '定时任务：郑州天气周报', updatedAt: 1, scheduledTaskId: 'task-a' },
    { id: 't2', title: '定时任务：解析图片', updatedAt: 1, scheduledTaskId: 'task-b' },
  ],
  scheduledTasks: {
    t1: { taskId: 'task-a', state: 'current', enabled: true, nextRunAt: null, lastStatus: 'success' },
    t2: { taskId: 'task-b', state: 'current', enabled: true, nextRunAt: null, lastStatus: 'success' },
  },
  sessionRunStates: [],
};

async function openSidebarPage(): Promise<Page> {
  const page = await browser.newPage();
  openPages.add(page);
  await page.setContent('<!DOCTYPE html><html><body><div class="app-shell"><div class="app-main"></div></div></body></html>');
  await page.evaluate((payload) => {
    const store = new Map<string, string>([['ice-chat-last-active-session', 'n1']]);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k) : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
    (window as any).__fetchUrls = [];
    (window as any).fetch = async (url: string, init?: { method?: string }) => {
      (window as any).__fetchUrls.push(url);
      if (url === '/api/sessions' && (!init || !init.method)) {
        return { ok: true, json: async () => JSON.parse(JSON.stringify(payload)) };
      }
      if (url === '/api/sessions' && init?.method === 'POST') {
        const session = { id: 'n9', title: '新会话', updatedAt: 2 };
        payload.sessions.unshift(session);
        return { ok: true, json: async () => ({ success: true, session: { ...session } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
  }, PAYLOAD);
  await page.addScriptTag({ content: STORE_SOURCE });
  await page.addScriptTag({ content: SIDEBAR_SOURCE });
  await page.evaluate(() => new Promise<void>((resolve) => {
    const store = (window as any).ChatSessionStore;
    store.fetchSessions(() => {
      store.setActiveSessionId('n1');
      (window as any).ChatSessionSidebar.create(document.querySelector('.app-shell'));
      resolve();
    });
  }));
  await page.waitForSelector('.chat-sidebar-list > *');
  return page;
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector('.chat-sidebar-search') as HTMLElement | null;
    const input = document.querySelector('.chat-sidebar-search-input') as HTMLInputElement | null;
    const btn = document.querySelector('.chat-sidebar-search-btn');
    const empty = document.querySelector('.chat-sidebar-list-empty');
    return {
      searchOpen: !!box && !box.hidden,
      inputFocused: !!input && document.activeElement === input,
      inputValue: input ? input.value : null,
      btnExpanded: btn ? btn.getAttribute('aria-expanded') : null,
      btnActive: !!btn && btn.classList.contains('is-active'),
      empty: empty ? empty.textContent : null,
      groups: document.querySelectorAll('.chat-sidebar-group').length,
      ids: Array.from(document.querySelectorAll('.chat-sidebar-item')).map((el) => el.getAttribute('data-id')),
      taskIds: Array.from(document.querySelectorAll('.chat-sidebar-item-chip')).map((el) => el.closest('.chat-sidebar-item')?.getAttribute('data-id')),
    };
  });
}

const typeKeyword = (page: Page, text: string) => page.locator('.chat-sidebar-search-input').fill(text);

describe('侧栏会话搜索（按标题）', () => {
  it('search.svg 与其它图标一样放在 public/icons 下', () => {
    const svg = path.join(__dirname, '../../src/public/icons/search.svg');
    expect(existsSync(svg)).toBe(true);
    expect(readFileSync(svg, 'utf-8')).toContain('currentColor');
  });

  it('搜索按钮在「会话」标题右侧；默认收起，点击后展开输入框并聚焦', async () => {
    const page = await openSidebarPage();
    const placement = await page.evaluate(() => {
      const btn = document.querySelector('.chat-sidebar-search-btn');
      return {
        inHeaderTop: !!btn && !!btn.closest('.chat-sidebar-header-top'),
        afterTitle: btn?.previousElementSibling?.classList.contains('chat-sidebar-title') ?? false,
      };
    });
    expect(placement).toEqual({ inHeaderTop: true, afterTitle: true });
    expect(await snapshot(page)).toMatchObject({ searchOpen: false, btnExpanded: 'false', btnActive: false });

    await page.locator('.chat-sidebar-search-btn').click();
    expect(await snapshot(page)).toMatchObject({
      searchOpen: true, inputFocused: true, btnExpanded: 'true', btnActive: true,
    });
  });

  it('关键字同时过滤普通会话和任务会话，忽略大小写', async () => {
    const page = await openSidebarPage();
    await page.locator('.chat-sidebar-search-btn').click();

    await typeKeyword(page, '周报');
    let s = await snapshot(page);
    expect(s.ids).toEqual(['n1', 't1']);
    expect(s.taskIds).toEqual(['t1']);

    await typeKeyword(page, 'NETTY');
    s = await snapshot(page);
    expect(s.ids).toEqual(['n2']);
    expect(s.taskIds).toEqual([]);

    await typeKeyword(page, '没有这个会话');
    s = await snapshot(page);
    expect(s.ids).toEqual([]);
    expect(s.empty).toBe('无匹配会话');
  });

  it('只做本地过滤，不发额外请求', async () => {
    const page = await openSidebarPage();
    const before = await page.evaluate(() => (window as any).__fetchUrls.length);
    await page.locator('.chat-sidebar-search-btn').click();
    await typeKeyword(page, 'agent');
    expect((await snapshot(page)).ids).toEqual(['n3']);
    expect(await page.evaluate(() => (window as any).__fetchUrls.length)).toBe(before);
  });

  it('任务会话和普通会话在同一条列表里，不再按折叠标题分开', async () => {
    const page = await openSidebarPage();
    const s = await snapshot(page);
    expect(s.groups).toBe(0);
    expect(s.ids).toEqual(['n1', 'n2', 'n3', 't1', 't2']);
    expect(s.taskIds).toEqual(['t1', 't2']);
  });

  it('Esc 清空并收起搜索，列表恢复全部会话', async () => {
    const page = await openSidebarPage();
    await page.locator('.chat-sidebar-search-btn').click();
    await typeKeyword(page, '周报');
    await page.locator('.chat-sidebar-search-input').press('Escape');
    const s = await snapshot(page);
    expect(s).toMatchObject({ searchOpen: false, inputValue: '', btnExpanded: 'false', btnActive: false });
    expect(s.ids).toEqual(['n1', 'n2', 'n3', 't1', 't2']);
  });

  it('再次点击搜索按钮也会清空并收起', async () => {
    const page = await openSidebarPage();
    await page.locator('.chat-sidebar-search-btn').click();
    await typeKeyword(page, 'netty');
    await page.locator('.chat-sidebar-search-btn').click();
    const s = await snapshot(page);
    expect(s).toMatchObject({ searchOpen: false, inputValue: '' });
    expect(s.ids).toEqual(['n1', 'n2', 'n3', 't1', 't2']);
  });

  it('搜索中新建会话会退出搜索，新会话可见', async () => {
    const page = await openSidebarPage();
    await page.locator('.chat-sidebar-search-btn').click();
    await typeKeyword(page, 'netty');
    await page.locator('.chat-sidebar-new-btn').click();
    await expect.poll(async () => (await snapshot(page)).ids).toEqual(['n9', 'n1', 'n2', 'n3', 't1', 't2']);
    expect((await snapshot(page)).searchOpen).toBe(false);
  });

  it('Store 推送刷新列表时保留关键字和输入焦点', async () => {
    const page = await openSidebarPage();
    await page.locator('.chat-sidebar-search-btn').click();
    await typeKeyword(page, '周报');
    await page.evaluate(() => { (window as any).ChatSessionStore.applySessionRunState('t1', 'running'); });
    const s = await snapshot(page);
    expect(s).toMatchObject({ searchOpen: true, inputFocused: true, inputValue: '周报' });
    expect(s.ids).toEqual(['n1', 't1']);
  });
});
