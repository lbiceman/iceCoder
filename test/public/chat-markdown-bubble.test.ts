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

describe('思考块收起预览', () => {
  it('收起后在 Thinking 后显示最近一行，长行露出结尾', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setViewportSize({ width: 960, height: 720 });
    await loadChat(page);
    await page.addStyleTag({ path: path.join(publicRoot, 'css/tokens.css') });
    await page.addStyleTag({ path: path.join(publicRoot, 'css/chat.css') });
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.body.style.background = '#111113';
    });

    const short = await page.evaluate(() => {
      const ui = (window as unknown as {
        ChatUI: { appendReasoningStreamChunk: (text: string) => void };
      }).ChatUI;
      ui.appendReasoningStreamChunk('先看布局。\n```ts\n');
      const block = document.querySelector('.message-thinking') as HTMLElement;
      const header = block.querySelector('.msg-thinking-toggle-header') as HTMLButtonElement;
      header.click();
      const preview = header.querySelector('.msg-thinking-preview') as HTMLElement;
      const text = header.querySelector('.msg-thinking-preview-text') as HTMLElement;
      const skippedFence = text.textContent || '';
      ui.appendReasoningStreamChunk('准备把预览接到 Thinking 后面。\n');
      return {
        collapsed: block.classList.contains('is-collapsed'),
        skippedFence,
        preview: text.textContent || '',
        label: header.querySelector('.msg-thinking-toggle-text')?.textContent || '',
        charSpans: header.querySelectorAll('.msg-thinking-char').length,
        previewDisplay: getComputedStyle(preview).display,
        bodyDisplay: getComputedStyle(block.querySelector('.msg-thinking-body') as Element).display,
        footerDisplay: getComputedStyle(block.querySelector('.msg-thinking-toggle-footer') as Element).display,
        truncated: preview.classList.contains('is-truncated'),
        textTransform: getComputedStyle(text).textTransform,
        aria: header.getAttribute('aria-label') || '',
        blockWidth: block.clientWidth,
      };
    });

    expect(short.collapsed).toBe(true);
    expect(short.skippedFence).toBe('先看布局。');
    expect(short.preview).toBe('准备把预览接到 Thinking 后面。');
    expect(short.label).toBe('Thinking');
    expect(short.charSpans).toBe(0);
    expect(short.previewDisplay).toBe('flex');
    expect(short.bodyDisplay).toBe('none');
    expect(short.footerDisplay).toBe('none');
    expect(short.truncated).toBe(false);
    expect(short.textTransform).toBe('none');
    expect(short.aria).toContain('准备把预览接到 Thinking 后面。');
    expect(short.blockWidth).toBeGreaterThan(180);
    expect(short.blockWidth).toBeLessThan(620);

    const expanded = await page.evaluate(() => {
      const block = document.querySelector('.message-thinking') as HTMLElement;
      const header = block.querySelector('.msg-thinking-toggle-header') as HTMLButtonElement;
      header.click();
      const preview = header.querySelector('.msg-thinking-preview') as HTMLElement;
      return {
        collapsed: block.classList.contains('is-collapsed'),
        previewDisplay: getComputedStyle(preview).display,
        bodyDisplay: getComputedStyle(block.querySelector('.msg-thinking-body') as Element).display,
        bodyText: block.querySelector('.msg-thinking-body')?.textContent || '',
      };
    });
    expect(expanded.collapsed).toBe(false);
    expect(expanded.previewDisplay).toBe('none');
    expect(expanded.bodyDisplay).not.toBe('none');
    expect(expanded.bodyText).toContain('先看布局。');
    expect(expanded.bodyText).toContain('准备把预览接到 Thinking 后面。');

    const long = await page.evaluate(() => {
      const ui = (window as unknown as {
        ChatUI: { appendReasoningStreamChunk: (text: string) => void };
      }).ChatUI;
      const block = document.querySelector('.message-thinking') as HTMLElement;
      const header = block.querySelector('.msg-thinking-toggle-header') as HTMLButtonElement;
      header.click();
      const ending = '结尾十二个字要露出来啊';
      const longLine = '甲'.repeat(50) + '乙'.repeat(50) + ending;
      ui.appendReasoningStreamChunk('\n' + longLine);
      const preview = header.querySelector('.msg-thinking-preview') as HTMLElement;
      const textEl = header.querySelector('.msg-thinking-preview-text') as HTMLElement;
      const clip = header.querySelector('.msg-thinking-preview-clip') as HTMLElement;
      const node = textEl.firstChild as Text;
      const range = document.createRange();
      const len = node.textContent ? node.textContent.length : 0;
      range.setStart(node, Math.max(0, len - 1));
      range.setEnd(node, len);
      const endRect = range.getBoundingClientRect();
      range.setStart(node, 0);
      range.setEnd(node, 1);
      const startRect = range.getBoundingClientRect();
      const clipRect = clip.getBoundingClientRect();
      const mark = getComputedStyle(header.querySelector('.msg-thinking-preview-mark') as Element, '::before').content;
      return {
        text: textEl.textContent || '',
        truncated: preview.classList.contains('is-truncated'),
        endInside: endRect.width > 0
          && endRect.right <= clipRect.right + 2
          && endRect.left >= clipRect.left - 1
          && endRect.left < clipRect.right,
        startOutside: startRect.right <= clipRect.left + 1,
        mark,
        contained: block.scrollWidth <= block.clientWidth + 2,
        clipWidth: clipRect.width,
        blockWidth: block.clientWidth,
      };
    });

    expect(long.text.endsWith('结尾十二个字要露出来啊')).toBe(true);
    expect(long.text.startsWith('甲')).toBe(true);
    expect(long.truncated).toBe(true);
    expect(long.endInside).toBe(true);
    expect(long.startOutside).toBe(true);
    expect(long.mark).toContain('…');
    expect(long.contained).toBe(true);
    expect(long.clipWidth).toBeGreaterThan(80);
    expect(long.blockWidth).toBeGreaterThan(400);

    await page.setViewportSize({ width: 420, height: 720 });
    const narrow = await page.evaluate(() => new Promise<Record<string, boolean | number>>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const block = document.querySelector('.message-thinking') as HTMLElement;
          const header = block.querySelector('.msg-thinking-toggle-header') as HTMLElement;
          const textEl = header.querySelector('.msg-thinking-preview-text') as HTMLElement;
          const clip = header.querySelector('.msg-thinking-preview-clip') as HTMLElement;
          const label = header.querySelector('.msg-thinking-toggle-text') as HTMLElement;
          const node = textEl.firstChild as Text;
          const range = document.createRange();
          const len = node.textContent ? node.textContent.length : 0;
          range.setStart(node, Math.max(0, len - 1));
          range.setEnd(node, len);
          const endRect = range.getBoundingClientRect();
          const clipRect = clip.getBoundingClientRect();
          const labelRect = label.getBoundingClientRect();
          resolve({
            endInside: endRect.width > 0
              && endRect.right <= clipRect.right + 2
              && endRect.left >= clipRect.left - 1,
            labelVisible: labelRect.width > 40 && labelRect.left >= block.getBoundingClientRect().left,
            contained: block.scrollWidth <= block.clientWidth + 2,
            blockWidth: block.clientWidth,
          });
        });
      });
    }));
    expect(narrow.endInside).toBe(true);
    expect(narrow.labelVisible).toBe(true);
    expect(narrow.contained).toBe(true);
    expect(narrow.blockWidth).toBeLessThan(400);
  });
});
