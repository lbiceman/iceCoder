import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const MARKDOWN_SOURCE = classicWindowSource(readFileSync(path.join(publicRoot, 'js/chat-markdown.ts'), 'utf-8'));
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
  await page.addScriptTag({ content: MARKDOWN_SOURCE });
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

describe('助手气泡 Markdown 渲染', () => {
  it('只渲染助手正文，用户气泡和解析失败都保持原文', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadChat(page);

    const result = await page.evaluate(() => {
      const ui = (window as unknown as {
        ChatUI: {
          appendMessageEl: (msg: Record<string, unknown>, strip: (t: string) => string) => void;
          appendStreamChunk: (text: string, messages: unknown[], strip: (t: string) => string) => void;
          appendReasoningStreamChunk: (text: string) => void;
        };
        ChatMarkdown: { render: (src: string) => string | null };
      }).ChatUI;
      const md = (window as unknown as { ChatMarkdown: { render: (src: string) => string | null } }).ChatMarkdown;

      ui.appendMessageEl({
        role: 'agent',
        content: '## 完成\n\n改了 `a.ts`。\n\n```ts\nconst n = 1;\n```',
      }, (t) => t);
      ui.appendMessageEl({ role: 'user', content: '**不要渲染** `我`' }, (t) => t);
      ui.appendMessageEl({ role: 'agent', content: '普通一句' }, (t) => t);
      ui.appendReasoningStreamChunk('**思考**');
      const streamingMessages: Array<Record<string, unknown>> = [];
      ui.appendStreamChunk('## 流式\n\n- 一项', streamingMessages, (t) => t);

      const agent = document.querySelector('.message.agent .msg-content');
      const user = document.querySelector('.message.user .msg-content');
      const plain = document.querySelectorAll('.message.agent .msg-content')[1];
      const thinking = document.querySelector('.message-thinking .msg-thinking-body');

      const rendered = {
        agentClass: agent ? agent.className : '',
        hasHeading: !!(agent && agent.querySelector('h2')),
        hasCode: !!(agent && agent.querySelector('pre code')),
        codeText: agent && agent.querySelector('pre code') ? agent.querySelector('pre code')!.textContent : '',
        userText: user ? user.textContent : '',
        userHasStrong: !!(user && user.querySelector('strong')),
        plainClass: plain ? plain.className : '',
        plainText: plain ? plain.textContent : '',
        thinkingText: thinking ? thinking.textContent : '',
        thinkingHasStrong: !!(thinking && thinking.querySelector('strong')),
        streamHeading: !!document.querySelector('#streaming-msg h2'),
        streamItem: !!document.querySelector('#streaming-msg li'),
      };

      md.render = () => {
        throw new Error('boom');
      };
      ui.appendMessageEl({ role: 'agent', content: '**失败也原文**' }, (t) => t);
      const failed = document.querySelectorAll('.message.agent .msg-content');
      const last = failed[failed.length - 1];
      return {
        ...rendered,
        failedClass: last ? last.className : '',
        failedText: last ? last.textContent : '',
      };
    });

    expect(result.agentClass).toContain('msg-content--md');
    expect(result.hasHeading).toBe(true);
    expect(result.hasCode).toBe(true);
    expect(result.codeText).toContain('const n = 1;');
    expect(result.userText).toBe('**不要渲染** `我`');
    expect(result.userHasStrong).toBe(false);
    expect(result.plainClass).not.toContain('msg-content--md');
    expect(result.plainText).toBe('普通一句');
    expect(result.thinkingText).toBe('**思考**');
    expect(result.thinkingHasStrong).toBe(false);
    expect(result.streamHeading).toBe(true);
    expect(result.streamItem).toBe(true);
    expect(result.failedClass).not.toContain('msg-content--md');
    expect(result.failedText).toBe('**失败也原文**');
  });
});
