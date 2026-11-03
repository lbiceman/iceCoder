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
    const items = Array.from(document.querySelectorAll('.chat-sidebar-item')).map((el) => {
      const chip = el.querySelector('.chat-sidebar-item-chip');
      return {
        id: el.getAttribute('data-id'),
        title: el.querySelector('.chat-sidebar-item-title')?.textContent,
        chip: chip?.textContent ?? null,
        chipTitle: chip?.getAttribute('title') ?? null,
        chipError: !!chip?.classList.contains('is-error'),
        active: el.classList.contains('active'),
      };
    });
    return {
      groups: document.querySelectorAll('.chat-sidebar-group').length,
      empty: document.querySelector('.chat-sidebar-list-empty')?.textContent ?? null,
      items,
    };
  });
}

const ids = (s: { items: Array<{ id: string | null }> }) => s.items.map((i) => i.id);

describe('侧栏会话列表：任务用标记区分，不再折叠分组', () => {
  it('普通会话和任务会话在同一条列表里，任务条目带标记', async () => {
    const page = await openSidebarPage();
    const s = await snapshot(page);
    expect(s.groups).toBe(0);
    expect(ids(s)).toEqual(['n1', 'tcur', 'told', 'n2', 'tgone', 'tfail']);
    expect(s.items.filter((i) => i.chip).map((i) => [i.id, i.title, i.chip, i.chipTitle])).toEqual([
      ['tcur', '解析图片', '任务', '下次 14:20'],
      ['told', '解析图片', '历史', '历史'],
      ['tgone', '旧任务', '已删除', '任务已删除'],
      ['tfail', '日报', '失败', '上次失败 · 已停用'],
    ]);
    expect(s.items.find((i) => i.id === 'tfail')?.chipError).toBe(true);
    expect(s.items.find((i) => i.id === 'n1')?.chip).toBeNull();
  });

  it('没有任务会话时不出现空的任务分组', async () => {
    const page = await openSidebarPage({ payload: NO_TASKS });
    const s = await snapshot(page);
    expect(s.groups).toBe(0);
    expect(ids(s)).toEqual(['n1', 'n2']);
    expect(s.items.every((i) => i.chip === null)).toBe(true);
    expect(s.empty).toBeNull();
  });

  it('停在任务会话上时，该会话直接出现在列表里并高亮', async () => {
    const page = await openSidebarPage({ activeId: 'tcur' });
    const s = await snapshot(page);
    expect(s.items.find((i) => i.id === 'tcur')).toMatchObject({ active: true, chip: '任务' });
  });

  it('revealSession 后新进列表的任务会话带任务标记', async () => {
    const page = await openSidebarPage();
    await page.evaluate(() => new Promise<void>((resolve) => {
      (window as any).ChatSessionSidebar.revealSession('tnew');
      const payload = (window as any).__sessionsPayload;
      payload.sessions.push({ id: 'tnew', title: '定时任务：新任务', updatedAt: 3, scheduledTaskId: 'task-n' });
      payload.scheduledTasks.tnew = { taskId: 'task-n', state: 'current', enabled: true, nextRunAt: null, lastStatus: 'idle' };
      (window as any).ChatSessionStore.fetchSessions(() => resolve());
    }));
    const s = await snapshot(page);
    expect(s.items.find((i) => i.id === 'tnew')).toMatchObject({ title: '新任务', chip: '任务' });
  });

  it('新建会话出现在列表最前，且没有任务标记', async () => {
    const page = await openSidebarPage();
    await page.locator('.chat-sidebar-new-btn').click();
    await expect.poll(async () => ids(await snapshot(page))).toEqual(['n3', 'n1', 'tcur', 'told', 'n2', 'tgone', 'tfail']);
    const s = await snapshot(page);
    expect(s.items.find((i) => i.id === 'n3')?.chip).toBeNull();
  });

  it('任务会话在跑时，圆点标在该条目上', async () => {
    const page = await openSidebarPage();
    expect(await page.locator('.chat-sidebar-item[data-id="tcur"] .chat-sidebar-item-run-dot').count()).toBe(0);
    await page.evaluate(() => {
      (window as any).ChatSessionStore.applySessionRunState('tcur', 'running');
    });
    expect(await page.locator('.chat-sidebar-item[data-id="tcur"] .chat-sidebar-item-run-dot.is-running').count()).toBe(1);
  });
});
