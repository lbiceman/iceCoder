import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { readClassicWindowSource } from './classic-window-source.ts';
import {
  USER_RULES_LIMITS,
  estimateUserRulesTokens,
  userRulesOverheadTokens,
  type UserRule,
} from '../../src/prompts/user-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TABS_SOURCE = readClassicWindowSource(path.join(__dirname, '../../src/public/js/knowledge-tabs.ts'));
const RULES_SOURCE = readClassicWindowSource(path.join(__dirname, '../../src/public/js/rules-page.ts'));

let browser: Browser;
const openPages = new Set<Page>();

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

afterEach(async () => {
  await Promise.all([...openPages].map((p) => p.close()));
  openPages.clear();
});

/** 页面内的假 /api/user-rules：保持与服务端一致的响应形状；`failNextSave` 用于模拟 400。 */
async function openRulesPage(initial: Array<Partial<UserRule>> = []): Promise<Page> {
  const page = await browser.newPage();
  openPages.add(page);
  await page.setContent('<!DOCTYPE html><html><body><div id="root"></div></body></html>');
  await page.evaluate(({ initialRules, limits, overhead }) => {
    const w = window as any;
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    });
    w.__calls = [];
    w.__notes = [];
    w.__failNextSave = '';
    w.Notification = {
      success: (m: string) => w.__notes.push(['success', m]),
      error: (m: string) => w.__notes.push(['error', m]),
    };
    w.Modal = { confirm: () => Promise.resolve(true) };
    let rules = initialRules.map((r: any, i: number) => ({ id: `r${i}`, enabled: true, createdAt: '', updatedAt: '', ...r }));
    let seq = rules.length;
    const reply = (status: number, body: any) => Promise.resolve({
      ok: status < 400,
      json: () => Promise.resolve(body),
    });
    w.fetch = (url: string, init: any = {}) => {
      const method = init.method || 'GET';
      const payload = init.body ? JSON.parse(init.body) : null;
      w.__calls.push({ method, url, payload });
      if (method !== 'GET' && w.__failNextSave) {
        const error = w.__failNextSave;
        w.__failNextSave = '';
        return reply(400, { success: false, error });
      }
      const id = decodeURIComponent(url.split('/').pop() || '');
      if (method === 'POST') rules.push({ id: `r${seq++}`, enabled: true, createdAt: '', updatedAt: '', ...payload });
      if (method === 'PUT') rules = rules.map((r: any) => (r.id === id ? { ...r, ...payload } : r));
      if (method === 'DELETE') rules = rules.filter((r: any) => r.id !== id);
      return reply(200, { success: true, rules, limits, overheadTokens: overhead });
    };
  }, { initialRules: initial, limits: USER_RULES_LIMITS, overhead: userRulesOverheadTokens() });
  await page.addScriptTag({ content: TABS_SOURCE });
  await page.addScriptTag({ content: RULES_SOURCE });
  await page.evaluate(() => (window as any).RulesPage.render(document.getElementById('root')));
  await page.waitForSelector('#rules-count:not(:text("载入中…"))');
  return page;
}

function statsText(page: Page) {
  return page.locator('#rules-stats').innerText();
}

function tokensInStats(text: string): number {
  const m = text.match(/约\s*(\d+)\s*tokens/);
  return m ? Number(m[1]) : NaN;
}

describe('知识库 · 规则页', () => {
  it('页签含「规则」，提示每次对话都会携带并显示 0 token', async () => {
    const page = await openRulesPage();
    expect(await page.locator('.knowledge-tab').allInnerTexts()).toEqual(['技能', '记忆', '规则']);
    expect(await page.locator('.knowledge-tab.is-active').innerText()).toBe('规则');
    const notice = (await page.locator('.rules-notice-text').allInnerTexts()).join('\n');
    expect(notice).toContain('每次对话都会携带');
    expect(notice).toContain('规则写得越多、越长，AI 越容易记混、漏掉，甚至不按规则来');
    expect(notice).toContain('最好不超过 10 条');
    expect(notice).toContain('每条最好在 200 字以内');
    expect(await statsText(page)).toContain('预计每轮输入增加约 0 tokens');
    expect(await page.locator('#rules-count').innerText()).toBe('0 条');
    expect(await page.locator('.rules-empty').count()).toBe(1);
  });

  it('输入时实时估算每轮 token，与服务端估算一致（±1）', async () => {
    const page = await openRulesPage([{ content: 'Run tests before finishing.' }]);
    await page.locator('#rules-add-btn').click();
    const text = '始终使用简体中文回复，代码标识符保持英文。';
    await page.locator('.rules-editor-input').fill(text);

    const expected = estimateUserRulesTokens([
      { id: 'a', content: 'Run tests before finishing.', enabled: true, createdAt: '', updatedAt: '' },
      { id: 'b', content: text, enabled: true, createdAt: '', updatedAt: '' },
    ]);
    const live = tokensInStats(await statsText(page));
    expect(Math.abs(live - expected)).toBeLessThanOrEqual(1);
    const remaining = USER_RULES_LIMITS.maxEnabledTotalChars - 'Run tests before finishing.'.length - text.length;
    expect(await page.locator('.rules-editor-count').innerText()).toContain(`本条 ${text.length} 字`);
    expect(await page.locator('.rules-editor-count').innerText()).toContain(`还可写 ${remaining} 字`);

    await page.locator('[data-action="save"]').click();
    await page.waitForSelector('.rules-card:not(.is-editing) >> text=始终使用简体中文回复');
    const calls = await page.evaluate(() => (window as any).__calls);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: '/api/user-rules', payload: { content: text } });
    expect(await statsText(page)).toContain('已启用 2 条');
  });

  it('不限条数：50 条合计 2999 字时第 51 条只能写 1 个字，写满后不能再新增', async () => {
    const initial = [
      ...Array.from({ length: 49 }, () => ({ content: 'x'.repeat(60) })),
      { content: 'y'.repeat(59) },
    ];
    const page = await openRulesPage(initial);
    expect(await page.locator('#rules-count').innerText()).toBe('50 条');
    expect(await page.locator('#rules-add-btn').isDisabled()).toBe(false);

    await page.locator('#rules-add-btn').click();
    const input = page.locator('.rules-editor-input');
    expect(await input.getAttribute('maxlength')).toBe('1');
    await input.pressSequentially('ab');
    expect(await input.inputValue()).toBe('a');
    expect(await page.locator('.rules-editor-count').innerText()).toContain('还可写 0 字');
    expect(await page.locator('[data-action="save"]').isDisabled()).toBe(false);

    await page.locator('[data-action="save"]').click();
    await expect.poll(() => page.locator('#rules-count').innerText()).toBe('51 条');
    expect(await page.locator('#rules-add-btn').isDisabled()).toBe(true);
    expect(await statsText(page)).toContain(`3000 / ${USER_RULES_LIMITS.maxEnabledTotalChars} 字`);
  });

  it('草稿超出合计额度时禁用保存并标红', async () => {
    const page = await openRulesPage([{ content: 'x'.repeat(USER_RULES_LIMITS.maxEnabledTotalChars - 1) }]);
    await page.locator('#rules-add-btn').click();
    // 绕过 maxlength（如程序化粘贴），仍应被拦住
    await page.locator('.rules-editor-input').evaluate((el: HTMLTextAreaElement) => {
      el.removeAttribute('maxlength');
      el.value = 'ab';
      el.dispatchEvent(new Event('input'));
    });
    expect(await page.locator('[data-action="save"]').isDisabled()).toBe(true);
    expect(await page.locator('.rules-stats').getAttribute('class')).toContain('is-over');
  });

  it('编辑已启用规则时额度不重复计算自身', async () => {
    const page = await openRulesPage([
      { content: 'x'.repeat(2000) },
      { content: 'y'.repeat(1000) },
    ]);
    expect(await page.locator('#rules-add-btn').isDisabled()).toBe(true);
    await page.locator('.rules-card[data-id="r1"] [data-action="edit"]').click();
    expect(await page.locator('.rules-editor-input').getAttribute('maxlength')).toBe('1000');
    expect(await page.locator('[data-action="save"]').isDisabled()).toBe(false);
  });

  it('开关停用规则发送 PUT enabled=false', async () => {
    const page = await openRulesPage([{ content: '规则一' }]);
    await page.locator('[data-action="toggle"]').uncheck();
    await expect.poll(() => page.locator('.rules-card.is-disabled').count()).toBe(1);
    const calls = await page.evaluate(() => (window as any).__calls);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: '/api/user-rules/r0', payload: { enabled: false } });
    expect(await statsText(page)).toContain('预计每轮输入增加约 0 tokens');
  });

  it('保存失败时保留草稿并提示原因', async () => {
    const page = await openRulesPage();
    await page.locator('#rules-add-btn').click();
    await page.locator('.rules-editor-input').fill('含敏感信息的规则');
    await page.evaluate(() => { (window as any).__failNextSave = '规则疑似包含敏感信息'; });
    await page.locator('[data-action="save"]').click();
    await expect.poll(() => page.evaluate(() => (window as any).__notes.length)).toBe(1);
    expect(await page.evaluate(() => (window as any).__notes[0])).toEqual(['error', '规则疑似包含敏感信息']);
    expect(await page.locator('.rules-editor-input').inputValue()).toBe('含敏感信息的规则');
  });

  it('编辑时锁定其他规则的操作，取消后恢复', async () => {
    const page = await openRulesPage([{ content: 'A' }, { content: 'B' }]);
    await page.locator('.rules-card[data-id="r0"] [data-action="edit"]').click();
    expect(await page.locator('.rules-card[data-id="r1"] [data-action="toggle"]').isDisabled()).toBe(true);
    expect(await page.locator('#rules-add-btn').isDisabled()).toBe(true);
    await page.locator('[data-action="cancel"]').click();
    expect(await page.locator('.rules-card[data-id="r1"] [data-action="toggle"]').isDisabled()).toBe(false);
  });
});
