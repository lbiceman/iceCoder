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

const NEXT_RUN_AT = (() => {
  const d = new Date();
  d.setHours(14, 20, 0, 0);
  return d.getTime();
})();

const WITH_TASKS = {
  sessions: [
    { id: 'n1', title: '普通会话一', updatedAt: 1 },
    { id: 'tcur', title: '定时任务：解析图片', updatedAt: 1, scheduledTaskId: 'task-a' },
    { id: 'told', title: '定时任务：解析图片', updatedAt: 1, scheduledTaskId: 'task-a' },
    { id: 'n2', title: '普通会话二', updatedAt: 1 },
    { id: 'tgone', title: '定时任务：旧任务', updatedAt: 1, scheduledTaskId: 'task-x' },
    { id: 'tfail', title: '定时任务：日报', updatedAt: 1 },
  ],
  scheduledTasks: {
    tcur: { taskId: 'task-a', state: 'current', enabled: true, nextRunAt: NEXT_RUN_AT, lastStatus: 'success' },
    told: { taskId: 'task-a', state: 'history' },
    tgone: { taskId: 'task-x', state: 'deleted' },
    tfail: { taskId: 'task-b', state: 'current', enabled: false, nextRunAt: null, lastStatus: 'error' },
  },
};

const NO_TASKS = {
  sessions: [
    { id: 'n1', title: '普通会话一', updatedAt: 1 },
    { id: 'n2', title: '普通会话二', updatedAt: 1 },
  ],
  scheduledTasks: {},
};

/** 真实 ChatSessionStore + 假的 GET /api/sessions，侧栏走完整的数据链路。 */
async function openSidebarPage(
  opts: { activeId?: string; payload?: unknown; storage?: Record<string, string> } = {},
): Promise<Page> {
  const page = await browser.newPage();
  openPages.add(page);
  await page.setContent('<!DOCTYPE html><html><body><div class="app-shell"><div class="app-main"></div></div></body></html>');
  await page.evaluate(({ activeId, payload, storage }) => {
    const store = new Map<string, string>(Object.entries(storage));
    if (activeId) store.set('ice-chat-last-active-session', activeId);
    (window as any).__dumpStorage = () => Object.fromEntries(store);
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => (store.has(k) ? store.get(k) : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
      },
    });
    (window as any).__sessionsPayload = { sessionRunStates: [], ...(payload as object) };
    (window as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
      const current = (window as any).__sessionsPayload;
      if (url === '/api/sessions' && (!init || !init.method)) {
        return { ok: true, json: async () => JSON.parse(JSON.stringify(current)) };
      }
      if (url === '/api/sessions' && init?.method === 'POST') {
        const session = { id: 'n3', title: '新会话', updatedAt: 2 };
        current.sessions.unshift(session);
        return { ok: true, json: async () => ({ success: true, session: { ...session } }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    };
  }, { activeId: opts.activeId ?? 'n1', payload: opts.payload ?? WITH_TASKS, storage: opts.storage ?? {} });
  await page.addScriptTag({ content: STORE_SOURCE });
  await page.addScriptTag({ content: SIDEBAR_SOURCE });
  await page.evaluate(() => new Promise<void>((resolve) => {
    const store = (window as any).ChatSessionStore;
    store.fetchSessions(() => {
      const stored = window.localStorage.getItem('ice-chat-last-active-session');
      if (stored) store.setActiveSessionId(stored);
      (window as any).ChatSessionSidebar.create(document.querySelector('.app-shell'));
      resolve();
    });
  }));
  await page.waitForSelector('.chat-sidebar-list > *');
  return page;
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const list = document.querySelector('.chat-sidebar-list');
    const items = (root: ParentNode | null | undefined) =>
      Array.from(root ? root.querySelectorAll('.chat-sidebar-item') : []).map((el) => ({
        id: el.getAttribute('data-id'),
        title: el.querySelector('.chat-sidebar-item-title')?.textContent,
        taskMeta: el.querySelector('.chat-sidebar-item-task-meta')?.textContent ?? null,
        taskMetaError: !!el.querySelector('.chat-sidebar-item-task-meta.is-error'),
        active: el.classList.contains('active'),
      }));
    const group = (name: string) => {
      const g = document.querySelector(`.chat-sidebar-group[data-group="${name}"]`);
      if (!g) return null;
      return {
        label: g.querySelector('.chat-sidebar-group-label')?.textContent,
        expanded: g.querySelector('.chat-sidebar-group-toggle')?.getAttribute('aria-expanded'),
        count: g.querySelector('.chat-sidebar-group-count')?.textContent,
        dot: g.querySelector('.chat-sidebar-group-run-dot')?.className ?? null,
        empty: g.querySelector('.chat-sidebar-group-empty')?.textContent ?? null,
        items: items(g),
      };
    };
    return {
      order: Array.from(list ? list.children : []).map((el) => el.getAttribute('data-group') || el.className),
      normal: group('normal'),
      task: group('task'),
    };
  });
}

const ids = (g: { items: Array<{ id: string | null }> } | null) => (g ? g.items.map((i) => i.id) : null);
const toggle = (page: Page, group: string) =>
  page.locator(`.chat-sidebar-group[data-group="${group}"] .chat-sidebar-group-toggle`).click();
const rerender = (page: Page) => page.evaluate(() => { (window as any).ChatSessionSidebar.renderList(); });

describe('侧栏会话分组：普通会话默认打开，任务会话默认关闭', () => {
  it('普通会话在上、默认打开；任务会话在下、默认关闭', async () => {
    const page = await openSidebarPage();
    const s = await snapshot(page);
    expect(s.order).toEqual(['normal', 'task']);
    expect(s.normal).toMatchObject({ label: '普通会话', expanded: 'true', count: '2' });
    expect(ids(s.normal)).toEqual(['n1', 'n2']);
    expect(s.task).toMatchObject({ label: '任务会话', expanded: 'false', count: '4', items: [] });
  });

  it('没有任务会话时两个分组照样显示，任务会话为空且默认关闭', async () => {
    const page = await openSidebarPage({ payload: NO_TASKS });
    let s = await snapshot(page);
    expect(s.order).toEqual(['normal', 'task']);
    expect(s.normal).toMatchObject({ expanded: 'true', count: '2' });
    expect(s.task).toMatchObject({ expanded: 'false', count: '0', items: [], empty: null });

    await toggle(page, 'task');
    s = await snapshot(page);
    expect(s.task).toMatchObject({ expanded: 'true', empty: '暂无任务会话' });
  });

  it('展开任务会话：当前绑定的在前，标题去掉前缀并显示任务状态', async () => {
    const page = await openSidebarPage();
    await toggle(page, 'task');
    const s = await snapshot(page);
    expect(s.task?.expanded).toBe('true');
    expect(s.task?.items.map((i) => [i.id, i.title, i.taskMeta])).toEqual([
      ['tcur', '解析图片', '下次 14:20'],
      ['tfail', '日报', '上次失败 · 已停用'],
      ['told', '解析图片', '历史'],
      ['tgone', '旧任务', '任务已删除'],
    ]);
    expect(s.task?.items.find((i) => i.id === 'tfail')?.taskMetaError).toBe(true);
    expect(ids(s.normal)).toEqual(['n1', 'n2']);
  });

  it('手动展开/折叠在页面内保持，重新打开页面回到默认', async () => {
    const page = await openSidebarPage();
    await toggle(page, 'task');
    await toggle(page, 'normal');
    await rerender(page);
    let s = await snapshot(page);
    expect(s.task?.expanded).toBe('true');
    expect(s.normal?.expanded).toBe('false');

    const storage = await page.evaluate(() => (window as any).__dumpStorage());
    const reopened = await openSidebarPage({ storage });
    s = await snapshot(reopened);
    expect(s.normal?.expanded).toBe('true');
    expect(s.task?.expanded).toBe('false');
  });

  it('上次停在任务会话上，打开页面时任务会话仍默认关闭', async () => {
    const page = await openSidebarPage({ activeId: 'tcur' });
    const s = await snapshot(page);
    expect(s.task?.expanded).toBe('false');
    expect(s.normal?.expanded).toBe('true');
  });

  it('revealSession 展开会话所在分组；会话稍后才进列表时等它出现再展开', async () => {
    const page = await openSidebarPage();
    await page.evaluate(() => { (window as any).ChatSessionSidebar.revealSession('tcur'); });
    let s = await snapshot(page);
    expect(s.task?.expanded).toBe('true');

    await toggle(page, 'task');
    await rerender(page);
    expect((await snapshot(page)).task?.expanded).toBe('false');

    await page.evaluate(() => new Promise<void>((resolve) => {
      (window as any).ChatSessionSidebar.revealSession('tnew');
      const payload = (window as any).__sessionsPayload;
      payload.sessions.push({ id: 'tnew', title: '定时任务：新任务', updatedAt: 3, scheduledTaskId: 'task-n' });
      payload.scheduledTasks.tnew = { taskId: 'task-n', state: 'current', enabled: true, nextRunAt: null, lastStatus: 'idle' };
      (window as any).ChatSessionStore.fetchSessions(() => resolve());
    }));
    s = await snapshot(page);
    expect(s.task?.expanded).toBe('true');
    expect(ids(s.task)).toContain('tnew');
  });

  it('新建会话进入普通会话；普通会话折叠时会自动打开显示新会话', async () => {
    const page = await openSidebarPage();
    await toggle(page, 'normal');
    expect((await snapshot(page)).normal?.expanded).toBe('false');
    await page.locator('.chat-sidebar-new-btn').click();
    await expect.poll(async () => ids((await snapshot(page)).normal)).toEqual(['n3', 'n1', 'n2']);
    const s = await snapshot(page);
    expect(s.normal?.expanded).toBe('true');
    expect(s.task).toMatchObject({ expanded: 'false', count: '4' });
  });

  it('折叠的分组里有会话在跑时组头显示运行圆点；展开后圆点回到条目上', async () => {
    const page = await openSidebarPage();
    expect((await snapshot(page)).task?.dot).toBeNull();
    await page.evaluate(() => {
      (window as any).ChatSessionStore.applySessionRunState('tcur', 'running');
    });
    expect((await snapshot(page)).task?.dot).toContain('is-running');

    await toggle(page, 'task');
    expect((await snapshot(page)).task?.dot).toBeNull();
    expect(await page.locator('.chat-sidebar-item[data-id="tcur"] .chat-sidebar-item-run-dot.is-running').count()).toBe(1);
  });
});
