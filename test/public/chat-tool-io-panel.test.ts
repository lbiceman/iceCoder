import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const TDH_SOURCE = classicWindowSource(readFileSync(path.join(publicRoot, 'js/tool-display-history.ts'), 'utf-8'));
const CHAT_UI_SOURCE = classicWindowSource(readFileSync(path.join(publicRoot, 'js/chat-ui.ts'), 'utf-8'));

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

async function loadChat(page: Page) {
  await page.setContent(
    '<!DOCTYPE html><html><body>' +
      '<div id="chat-messages" class="chat-messages">' +
        '<div id="chat-anchor" class="chat-messages-anchor"></div>' +
      '</div>' +
      '<textarea id="chat-input"></textarea>' +
      '<button id="chat-send" type="button">send</button>' +
    '</body></html>',
  );
  await page.addScriptTag({ content: TDH_SOURCE });
  await page.addScriptTag({ content: CHAT_UI_SOURCE });
  await page.evaluate(() => {
    (window as unknown as { ChatUI: { init: (els: Record<string, unknown>) => void } }).ChatUI.init({
      elMessages: document.getElementById('chat-messages'),
      elAnchor: document.getElementById('chat-anchor'),
      elInput: document.getElementById('chat-input'),
      elSendBtn: document.getElementById('chat-send'),
    });
  });
}

describe('工具参数/结果面板', () => {
  it('非变更类工具（web_search）点击工具名展开参数与结果', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadChat(page);

    const result = await page.evaluate(() => {
      const ui = (window as unknown as {
        ChatUI: {
          appendToolAction: (n: string, d: string, s: string, id: string, diff: unknown, args: unknown) => void;
          updateToolActionByCallId: (n: string, t: string, s: string, out: string) => void;
        };
      }).ChatUI;
      ui.appendToolAction('web_search', 'UI design', 'success', 'tc-1', null, { query: 'ui design', maxResults: 3 });
      const block = document.querySelector('.tool-action-row-block[data-tool-call-id="tc-1"]')!;
      const nameEl = block.querySelector('.tool-name') as HTMLElement;
      const hasToggleClass = nameEl.classList.contains('tool-io-toggle');
      const hasDiffClass = nameEl.classList.contains('tool-diff-toggle');
      ui.updateToolActionByCallId('tc-1', 'web_search', 'success', 'RESULT_BODY_42');
      nameEl.click();
      const wrap = block.querySelector('.tool-io-wrap');
      const pre = wrap ? wrap.querySelector('.tool-io-pre') : null;
      return {
        hasToggleClass,
        hasDiffClass,
        hasIo: block.getAttribute('data-has-io'),
        open: wrap ? wrap.classList.contains('is-open') : false,
        text: pre ? pre.textContent : '',
      };
    });

    expect(result.hasToggleClass).toBe(true);
    expect(result.hasDiffClass).toBe(false);
    expect(result.hasIo).toBe('1');
    expect(result.open).toBe(true);
    expect(result.text).toContain('ui design');
    expect(result.text).toContain('RESULT_BODY_42');
  });

  it('变更类工具（write_file）仍走 diff 面板，不挂 IO 面板', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadChat(page);

    const result = await page.evaluate(() => {
      const ui = (window as unknown as {
        ChatUI: { appendToolAction: (n: string, d: string, s: string, id: string, diff: unknown, args: unknown) => void };
      }).ChatUI;
      ui.appendToolAction('write_file', 'a.ts', 'success', 'tc-2', null, { path: 'a.ts', content: 'x' });
      const block = document.querySelector('.tool-action-row-block[data-tool-call-id="tc-2"]')!;
      const nameEl = block.querySelector('.tool-name') as HTMLElement;
      return {
        hasDiffClass: nameEl.classList.contains('tool-diff-toggle'),
        hasIoClass: nameEl.classList.contains('tool-io-toggle'),
      };
    });

    expect(result.hasDiffClass).toBe(true);
    expect(result.hasIoClass).toBe(false);
  });
});
