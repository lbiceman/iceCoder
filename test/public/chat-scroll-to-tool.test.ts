import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const CHAT_UI_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-ui.js'), 'utf-8');

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

async function loadChatUi(page: Page) {
  await page.setContent(
    '<!DOCTYPE html><html><body>' +
      '<div id="chat-messages" class="chat-messages">' +
        '<div id="chat-anchor" class="chat-messages-anchor"></div>' +
      '</div>' +
      '<textarea id="chat-input"></textarea>' +
      '<button id="chat-send" type="button">send</button>' +
    '</body></html>',
  );
  await page.addScriptTag({ content: CHAT_UI_SOURCE });
  await page.evaluate(() => {
    const ui = (window as any).ChatUI;
    ui.init({
      elMessages: document.getElementById('chat-messages'),
      elAnchor: document.getElementById('chat-anchor'),
      elInput: document.getElementById('chat-input'),
      elSendBtn: document.getElementById('chat-send'),
    });
  });
}

describe('定位到对话工具行', () => {
  it('首次滚动前先脱离贴底跟随，避免 overflow-anchor 把 smooth scroll 拽停', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadChatUi(page);

    const result = await page.evaluate(async () => {
      const ui = (window as any).ChatUI;
      const messagesEl = document.getElementById('chat-messages') as HTMLElement;
      const tail = messagesEl.querySelector('.chat-tail-root') as HTMLElement;
      const block = document.createElement('div');
      block.className = 'tool-action-row-block';
      block.setAttribute('data-tool-call-id', 'call-first-scroll');
      const row = document.createElement('div');
      row.className = 'tool-action';
      row.textContent = 'write_file';
      block.appendChild(row);
      tail.insertBefore(block, tail.querySelector('.chat-tail-anchor'));

      let scrolled = false;
      block.scrollIntoView = () => { scrolled = true; };

      const beforeFollow = messagesEl.classList.contains('is-follow-bottom');
      const beforeAuto = ui.isAutoScrollEnabled();
      const ok = ui.scrollToToolCall('call-first-scroll');
      const afterFollow = messagesEl.classList.contains('is-follow-bottom');
      const afterAuto = ui.isAutoScrollEnabled();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 450));
      return {
        ok,
        beforeFollow,
        beforeAuto,
        afterFollow,
        afterAuto,
        stillFollow: messagesEl.classList.contains('is-follow-bottom'),
        stillAuto: ui.isAutoScrollEnabled(),
        scrolled,
      };
    });

    expect(result.ok).toBe(true);
    expect(result.beforeFollow).toBe(true);
    expect(result.beforeAuto).toBe(true);
    expect(result.afterFollow).toBe(false);
    expect(result.afterAuto).toBe(false);
    expect(result.stillFollow).toBe(false);
    expect(result.stillAuto).toBe(false);
    expect(result.scrolled).toBe(true);
    await page.close();
  });
});
