import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const QUEUE_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-task-queue.js'), 'utf-8');
const PAGE_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-page.js'), 'utf-8');

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

describe('消息队列卡片', () => {
  it('直接发送与 /next 走同一套忙碌入队，不单独标 explicit', () => {
    expect(PAGE_SOURCE).toContain('function stripNextPrefix');
    expect(PAGE_SOURCE).toContain('var appendUserMessageNow = !busyAtSend');
    expect(PAGE_SOURCE).toContain('addOptimistic');
    expect(PAGE_SOURCE).not.toContain('sendOpts.source = \'explicit\'');
    expect(PAGE_SOURCE).not.toContain('sendOpts.command = \'next\'');
    expect(QUEUE_SOURCE).toContain('function addOptimistic');
  });

  it('addOptimistic 会在输入框上方显示队列卡片', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent(
      '<div class="chat-input-area"><div class="chat-composer-stack"><div class="chat-composer"></div></div></div>',
    );
    await page.addScriptTag({ content: QUEUE_SOURCE });
    const visible = await page.evaluate(() => {
      const area = document.querySelector('.chat-input-area') as HTMLElement;
      (window as any).ChatTaskQueue.init({
        container: area,
        getSessionId: () => 's1',
      });
      (window as any).ChatTaskQueue.addOptimistic({ text: '你是谁?' });
      const root = document.getElementById('chat-task-queue');
      const composer = area.querySelector('.chat-composer');
      return {
        hidden: root ? root.classList.contains('hidden') : true,
        text: root ? root.textContent : '',
        beforeComposer: !!(root && composer && root.nextElementSibling === composer),
      };
    });
    expect(visible.hidden).toBe(false);
    expect(visible.text).toContain('你是谁?');
    expect(visible.text).toContain('消息队列');
    expect(visible.beforeComposer).toBe(true);
    await page.close();
  });

  it('队列项展示 + 上传或粘贴的图片缩略图', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent(
      '<div class="chat-input-area"><div class="chat-composer-stack"><div class="chat-composer"></div></div></div>',
    );
    await page.addScriptTag({ content: QUEUE_SOURCE });
    const result = await page.evaluate(() => {
      const area = document.querySelector('.chat-input-area') as HTMLElement;
      (window as any).ChatTaskQueue.init({
        container: area,
        getSessionId: () => 's1',
      });
      const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      (window as any).ChatTaskQueue.addOptimistic({
        text: '这套UI好做吗？',
        images: [dataUrl],
      });
      const img = document.querySelector('.chat-task-queue-thumb') as HTMLImageElement | null;
      return {
        hasThumb: !!img,
        src: img ? img.getAttribute('src') : '',
        text: document.getElementById('chat-task-queue')?.textContent || '',
      };
    });
    expect(result.hasThumb).toBe(true);
    expect(result.src.startsWith('data:image/png')).toBe(true);
    expect(result.text).toContain('这套UI好做吗？');
    await page.close();
  });
});
