import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDEBAR_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/chat-session-sidebar.ts'),
  'utf-8',
));
const KNOWLEDGE_TABS_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/knowledge-tabs.ts'),
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

async function openSidebarPage(): Promise<Page> {
  const page = await browser.newPage();
  openPages.add(page);
  await page.setContent('<!DOCTYPE html><html><body><div class="app-shell"><div class="app-main"></div></div></body></html>');
  await page.evaluate(() => {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k) : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
    (window as any).ChatSessionStore = {
      sessions: [
        { id: 's1', title: '当前会话', updatedAt: Date.now() },
        { id: 's2', title: '另一个会话', updatedAt: Date.now() - 60_000 },
      ],
      activeSessionId: 's1',
      getSessions() { return this.sessions; },
      getActiveSessionId() { return this.activeSessionId; },
      fetchSessions(cb: () => void) { if (cb) cb(); },
      onChange() {},
      getSessionWorkspace() { return ''; },
      getDefaultWorkDir() { return ''; },
      isDefaultWorkspace() { return true; },
      switchSession(id: string, _send: unknown, cb: (ok: boolean) => void) {
        this.activeSessionId = id;
        if (cb) cb(true);
      },
    };
  });
  await page.addScriptTag({ content: KNOWLEDGE_TABS_SOURCE });
  await page.addScriptTag({ content: SIDEBAR_SOURCE });
  await page.evaluate(() => {
    (window as any).ChatSessionSidebar.create(document.querySelector('.app-shell'));
  });
  return page;
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const activeItem = document.querySelector('.chat-sidebar-item.active');
    const activeNav = document.querySelector('.chat-sidebar-nav-btn.is-active');
    const settingsBtn = document.querySelector('.chat-sidebar-settings-btn');
    const statsBtn = document.querySelector('.chat-sidebar-stats-btn');
    return {
      hash: window.location.hash,
      navLabels: Array.from(document.querySelectorAll('.chat-sidebar-nav-btn-label')).map((el) => el.textContent),
      chatNavCount: document.querySelectorAll('.chat-sidebar-nav-btn[data-page="chat"]').length,
      activeSessionId: activeItem ? activeItem.getAttribute('data-id') : null,
      activeNavPage: activeNav ? activeNav.getAttribute('data-page') : null,
      settingsActive: !!(settingsBtn && settingsBtn.classList.contains('is-active')),
      statsActive: !!(statsBtn && statsBtn.classList.contains('is-active')),
      storeActive: (window as any).ChatSessionStore.getActiveSessionId(),
    };
  });
}

describe('桌面侧栏主导航与会话列表', () => {
  it('主导航包含工作入口', async () => {
    const page = await openSidebarPage();
    const state = await snapshot(page);
    expect(state.navLabels).toEqual(['工作', '任务', '知识库']);
    expect(state.chatNavCount).toBe(1);
    expect(state.activeNavPage).toBe('chat');
  });

  it('知识库入口覆盖技能/记忆两个路由，并打开上次停留的页签', async () => {
    const page = await openSidebarPage();

    await page.locator('.chat-sidebar-nav-btn[data-page="knowledge"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/skills',
      activeNavPage: 'knowledge',
      activeSessionId: null,
    });

    await page.evaluate(() => {
      (window as any).KnowledgeTabs.remember('memory');
      window.location.hash = '#/memory';
    });
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/memory',
      activeNavPage: 'knowledge',
    });

    await page.locator('.chat-sidebar-nav-btn[data-page="tasks"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/tasks',
      activeNavPage: 'tasks',
      activeSessionId: null,
    });

    await page.locator('.chat-sidebar-nav-btn[data-page="knowledge"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/memory',
      activeNavPage: 'knowledge',
    });
  });

  it('任务/知识库/统计/设置页取消会话高亮，点击会话回到聊天页', async () => {
    const page = await openSidebarPage();
    expect(await snapshot(page)).toMatchObject({
      activeSessionId: 's1',
      activeNavPage: 'chat',
    });

    await page.locator('.chat-sidebar-nav-btn[data-page="tasks"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/tasks',
      activeNavPage: 'tasks',
      activeSessionId: null,
      storeActive: 's1',
    });

    await page.locator('.chat-sidebar-item[data-id="s1"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/chat',
      activeSessionId: 's1',
      activeNavPage: 'chat',
    });

    await page.locator('.chat-sidebar-stats-btn').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/stats',
      statsActive: true,
      activeNavPage: null,
      activeSessionId: null,
    });

    await page.locator('.chat-sidebar-item[data-id="s2"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/chat',
      activeSessionId: 's2',
      activeNavPage: 'chat',
      storeActive: 's2',
    });

    await page.locator('.chat-sidebar-settings-btn').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/settings',
      settingsActive: true,
      activeSessionId: null,
      activeNavPage: null,
      storeActive: 's2',
    });

    await page.locator('.chat-sidebar-item[data-id="s2"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/chat',
      activeSessionId: 's2',
      activeNavPage: 'chat',
      settingsActive: false,
    });
  });
});
