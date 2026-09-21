import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDEBAR_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-session-sidebar.js'),
  'utf-8',
);

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
    return {
      hash: window.location.hash,
      navLabels: Array.from(document.querySelectorAll('.chat-sidebar-nav-btn-label')).map((el) => el.textContent),
      chatNavCount: document.querySelectorAll('.chat-sidebar-nav-btn[data-page="chat"]').length,
      activeSessionId: activeItem ? activeItem.getAttribute('data-id') : null,
      activeNavPage: activeNav ? activeNav.getAttribute('data-page') : null,
      settingsActive: !!(settingsBtn && settingsBtn.classList.contains('is-active')),
      storeActive: (window as any).ChatSessionStore.getActiveSessionId(),
    };
  });
}

describe('桌面侧栏主导航与会话列表', () => {
  it('主导航包含工作入口', async () => {
    const page = await openSidebarPage();
    const state = await snapshot(page);
    expect(state.navLabels).toEqual(['工作', '记忆', '技能', '统计']);
    expect(state.chatNavCount).toBe(1);
    expect(state.activeNavPage).toBe('chat');
  });

  it('记忆/技能/统计/设置页取消会话高亮，点击会话回到聊天页', async () => {
    const page = await openSidebarPage();
    expect(await snapshot(page)).toMatchObject({
      activeSessionId: 's1',
      activeNavPage: 'chat',
    });

    await page.locator('.chat-sidebar-nav-btn[data-page="memory"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/memory',
      activeNavPage: 'memory',
      activeSessionId: null,
      storeActive: 's1',
    });

    await page.locator('.chat-sidebar-item[data-id="s1"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/chat',
      activeSessionId: 's1',
      activeNavPage: 'chat',
    });

    await page.locator('.chat-sidebar-nav-btn[data-page="stats"]').click();
    await expect.poll(async () => snapshot(page)).toMatchObject({
      hash: '#/stats',
      activeNavPage: 'stats',
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
