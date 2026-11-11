import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
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

const CHAT_UI_HTML =
  '<!DOCTYPE html><html><body>' +
    '<div id="chat-messages" class="chat-messages">' +
      '<div id="chat-anchor" class="chat-messages-anchor"></div>' +
    '</div>' +
    '<textarea id="chat-input"></textarea>' +
    '<button id="chat-send" type="button">send</button>' +
  '</body></html>';

async function loadChatUi(page: Page, locale?: 'zh' | 'en') {
  if (locale) {
    const url = 'http://127.0.0.1:9/token-bar';
    await page.route(url, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: CHAT_UI_HTML,
    }));
    await page.goto(url);
    await page.evaluate((next) => localStorage.setItem('ice-locale', next), locale);
  } else {
    await page.setContent(CHAT_UI_HTML);
  }
  await page.addScriptTag({ content: CHAT_UI_SOURCE });
  await page.evaluate(() => {
    const ui = (window as unknown as { ChatUI: { init: (els: Record<string, unknown>) => void } }).ChatUI;
    ui.init({
      elMessages: document.getElementById('chat-messages'),
      elAnchor: document.getElementById('chat-anchor'),
      elInput: document.getElementById('chat-input'),
      elSendBtn: document.getElementById('chat-send'),
    });
  });
}

describe('聊天气泡 Token 条使用模型', () => {
  it('合计右侧展示气泡级 usedModel', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadChatUi(page);

    const text = await page.evaluate(() => {
      const ui = (window as unknown as {
        ChatUI: {
          appendMessageEl: (msg: Record<string, unknown>, strip: (t: string) => string) => HTMLElement;
        };
      }).ChatUI;
      ui.appendMessageEl({
        role: 'agent',
        id: 'a1',
        content: '已完成',
        turnTokenUsage: { inputTokens: 230930, outputTokens: 637 },
        usedModel: 'DeepSeek-V3.2',
      }, (t) => t);
      const bar = document.querySelector('.msg-token-usage');
      return bar ? (bar.textContent || '') : '';
    });

    expect(text).toContain('输入');
    expect(text).toContain('输出');
    expect(text).toContain('合计');
    expect(text).toContain('模型');
    expect(text).toContain('DeepSeek-V3.2');
  });

  it('英文下展示 Input、Output、Total、Model', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadChatUi(page, 'en');

    const text = await page.evaluate(() => {
      const ui = (window as unknown as {
        ChatUI: {
          appendMessageEl: (msg: Record<string, unknown>, strip: (t: string) => string) => HTMLElement;
        };
      }).ChatUI;
      ui.appendMessageEl({
        role: 'agent',
        id: 'a2',
        content: 'done',
        turnTokenUsage: { inputTokens: 65555, outputTokens: 4327 },
        usedModel: 'deepseek/deepseek-v4.1-flash',
      }, (t) => t);
      ui.appendMessageEl({
        role: 'agent',
        id: 'a3',
        content: 'done',
        turnTokenUsage: { inputTokens: 10, outputTokens: 2 },
        agentTokenUsage: { tokens: 1200, agents: 2 },
      }, (t) => t);
      const bars = Array.from(document.querySelectorAll('.msg-token-usage'));
      return bars.map((bar) => bar.textContent || '').join('\n');
    });

    expect(text).toContain('Input');
    expect(text).toContain('Output');
    expect(text).toContain('Total');
    expect(text).toContain('Model');
    expect(text).toContain('deepseek/deepseek-v4.1-flash');
    expect(text).toContain('Main agent');
    expect(text).toContain('Sub-agents ×2');
    expect(text).not.toContain('输入');
    expect(text).not.toContain('合计');
  });
});
