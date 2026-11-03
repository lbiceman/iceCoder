import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MENU_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/menu.ts'),
  'utf-8',
));
const SIDEBAR_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/chat-session-sidebar.ts'),
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
    const now = Date.now();
    const state = {
      sessions: [
        { id: 's1', title: '今天的会话', updatedAt: now },
        { id: 's2', title: '上周会话', updatedAt: now - 3 * 86400000 },
        { id: 's3', title: '更早会话', updatedAt: now - 20 * 86400000 },
      ],
      activeSessionId: 's1',
      deleted: [] as string[],
    };
    (window as any).__sidebarState = state;
    (window as any).ChatSessionStore = {
      getSessions() { return state.sessions; },
      getActiveSessionId() { return state.activeSessionId; },
      fetchSessions(cb: () => void) { if (cb) cb(); },
      onChange() {},
      getSessionWorkspace() { return 'C:/Users/tpln/work'; },
      getDefaultWorkDir() { return 'C:/Users/tpln/work'; },
      isDefaultWorkspace() { return false; },
      switchSession(id: string, _send: unknown, cb: (ok: boolean) => void) {
        state.activeSessionId = id;
        if (cb) cb(true);
      },
      deleteSession(id: string, _send: unknown, cb: (ok: boolean, info: { switchedTo?: string } | null) => void) {
        state.deleted.push(id);
        const wasActive = state.activeSessionId === id;
        state.sessions = state.sessions.filter((s) => s.id !== id);
        if (wasActive && state.sessions[0]) state.activeSessionId = state.sessions[0].id;
        if (cb) cb(true, wasActive && state.sessions[0] ? { switchedTo: state.sessions[0].id } : null);
      },
      setSessionPinned(id: string, pinned: boolean, cb?: (ok: boolean) => void) {
        const session = state.sessions.find((s) => s.id === id) as { pinnedAt?: number } | undefined;
        if (!session) {
          if (cb) cb(false);
          return;
        }
        if (pinned) {
          if (typeof session.pinnedAt !== 'number') session.pinnedAt = Date.now();
        } else {
          delete session.pinnedAt;
        }
        if (cb) cb(true);
      },
    };
    (window as any).Modal = {
      confirm() { return Promise.resolve(true); },
    };
  });
  await page.addScriptTag({ content: MENU_SOURCE });
  await page.addScriptTag({ content: SIDEBAR_SOURCE });
  await page.evaluate(() => {
    (window as any).ChatSessionSidebar.create(document.querySelector('.app-shell'));
  });
  return page;
}

describe('侧栏会话多选与层次', () => {
  it('左键打开会话，不出现勾选；右键菜单只有重命名、选择、删除', async () => {
    const page = await openSidebarPage();
    await page.locator('.chat-sidebar-item[data-id="s2"]').click();
    const afterClick = await page.evaluate(() => ({
      active: document.querySelector('.chat-sidebar-item.active')?.getAttribute('data-id'),
      checks: document.querySelectorAll('.chat-sidebar-item-check').length,
      selecting: document.querySelector('.chat-session-sidebar')?.classList.contains('is-selecting'),
      storeActive: (window as any).ChatSessionStore.getActiveSessionId(),
    }));
    expect(afterClick).toEqual({
      active: 's2',
      checks: 0,
      selecting: false,
      storeActive: 's2',
    });

    await page.locator('.chat-sidebar-item[data-id="s1"]').click({ button: 'right' });
    const menu = await page.evaluate(() => {
      const el = document.querySelector('.app-menu');
      return {
        open: !!el && !el.hasAttribute('hidden'),
        labels: Array.from(document.querySelectorAll('.app-menu-item .app-menu-label')).map((n) => n.textContent),
      };
    });
    expect(menu).toEqual({ open: true, labels: ['重命名', '置顶', '选择', '删除'] });
    expect(await page.evaluate(() => (window as any).ChatSessionStore.getActiveSessionId())).toBe('s2');
  });

  it('先置顶的会话排在后置顶的上面', async () => {
    const page = await openSidebarPage();
    await page.locator('.chat-sidebar-item[data-id="s3"]').click({ button: 'right' });
    await page.locator('.app-menu-item[data-action="pin"]').click();
    await page.locator('.chat-sidebar-item[data-id="s2"]').click({ button: 'right' });
    await page.locator('.app-menu-item[data-action="pin"]').click();
    const order = await page.evaluate(() => (
      Array.from(document.querySelectorAll('.chat-sidebar-item')).map((el) => el.getAttribute('data-id'))
    ));
    expect(order.slice(0, 2)).toEqual(['s3', 's2']);
    expect(await page.locator('.chat-sidebar-item[data-id="s3"] .chat-sidebar-item-chip').innerText()).toBe('置顶');

    await page.locator('.chat-sidebar-item[data-id="s3"]').click({ button: 'right' });
    const label = await page.locator('.app-menu-item[data-action="pin"] .app-menu-label').innerText();
    expect(label).toBe('取消置顶');
    await page.locator('.app-menu-item[data-action="pin"]').click();
    const after = await page.evaluate(() => (
      Array.from(document.querySelectorAll('.chat-sidebar-item')).map((el) => el.getAttribute('data-id'))
    ));
    expect(after[0]).toBe('s2');
    expect(after).toContain('s3');
    expect(after.indexOf('s2')).toBeLessThan(after.indexOf('s3'));
  });

  it('选择后出现勾选和删除条，点其他会话只切换勾选，可批量删除', async () => {
    const page = await openSidebarPage();
    await page.locator('.chat-sidebar-item[data-id="s1"]').click({ button: 'right' });
    await page.locator('.app-menu-item[data-action="select"]').click();

    const entered = await page.evaluate(() => ({
      selecting: document.querySelector('.chat-session-sidebar')?.classList.contains('is-selecting'),
      checked: Array.from(document.querySelectorAll('.chat-sidebar-item.is-checked')).map((el) => el.getAttribute('data-id')),
      count: document.querySelector('.chat-sidebar-selectbar-count')?.textContent,
      batchHidden: document.querySelector('.chat-sidebar-batchbar')?.hasAttribute('hidden'),
      selectHidden: document.querySelector('.chat-sidebar-selectbar')?.hasAttribute('hidden'),
    }));
    expect(entered).toEqual({
      selecting: true,
      checked: ['s1'],
      count: '1',
      batchHidden: false,
      selectHidden: false,
    });

    await page.locator('.chat-sidebar-item[data-id="s3"]').click();
    const toggled = await page.evaluate(() => ({
      checked: Array.from(document.querySelectorAll('.chat-sidebar-item.is-checked')).map((el) => el.getAttribute('data-id')),
      activeStore: (window as any).ChatSessionStore.getActiveSessionId(),
      count: document.querySelector('.chat-sidebar-selectbar-count')?.textContent,
    }));
    expect(toggled.activeStore).toBe('s1');
    expect(toggled.count).toBe('2');
    expect(toggled.checked).toEqual(['s1', 's3']);

    await page.locator('.chat-sidebar-batch-delete').click();
    await expect.poll(() => page.evaluate(() => (window as any).__sidebarState.deleted)).toEqual(['s3', 's1']);
    const left = await page.evaluate(() => ({
      ids: Array.from(document.querySelectorAll('.chat-sidebar-item')).map((el) => el.getAttribute('data-id')),
      selecting: document.querySelector('.chat-session-sidebar')?.classList.contains('is-selecting'),
    }));
    expect(left).toEqual({ ids: ['s2'], selecting: false });
  });

  it('普通会话按时间分段，底部是头像和昵称', async () => {
    const page = await openSidebarPage();
    const view = await page.evaluate(() => ({
      times: Array.from(document.querySelectorAll('.chat-sidebar-time')).map((el) => el.textContent),
      ids: Array.from(document.querySelectorAll('.chat-sidebar-item')).map((el) => el.getAttribute('data-id')),
      name: document.querySelector('.chat-sidebar-user-name')?.textContent,
      avatar: document.querySelector('.chat-sidebar-user-avatar svg') ? 'svg' : '',
      settings: document.querySelector('.chat-sidebar-settings-btn .chat-sidebar-control-label')?.textContent,
    }));
    expect(view.ids).toEqual(['s1', 's2', 's3']);
    expect(view.times).toEqual(['今天', '7天内', '30天内']);
    expect(view.name).toBe('tpln');
    expect(view.avatar).toBe('svg');
    expect(view.settings).toBe('设置');
  });
});
