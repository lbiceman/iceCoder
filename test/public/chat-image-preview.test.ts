import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const PREVIEW_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-image-preview.js'), 'utf-8');
const MAIN_SOURCE = readFileSync(path.join(publicRoot, 'js/main.js'), 'utf-8');
const CHAT_CSS = readFileSync(path.join(publicRoot, 'css/chat.css'), 'utf-8');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

describe('聊天气泡图片预览', () => {
  it('入口会加载预览模块，样式支持全图遮罩', () => {
    expect(MAIN_SOURCE).toContain("import './chat-image-preview.js'");
    expect(CHAT_CSS).toContain('.image-preview-overlay');
    expect(PREVIEW_SOURCE).toContain('msg-image-thumb');
  });

  it('点击气泡缩略图会展开全图，再点遮罩关闭', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent(
      '<div class="message user"><div class="msg-images"><img class="msg-image-thumb" src="' + PNG + '" alt="图片 1"></div></div>',
    );
    await page.addScriptTag({ content: PREVIEW_SOURCE });
    await page.click('.msg-image-thumb');
    await page.waitForSelector('.image-preview-overlay');
    const opened = await page.evaluate(() => {
      const full = document.querySelector('.image-preview-full') as HTMLImageElement | null;
      return {
        hasOverlay: !!document.querySelector('.image-preview-overlay'),
        src: full ? full.getAttribute('src') : '',
      };
    });
    expect(opened.hasOverlay).toBe(true);
    expect(opened.src).toContain('data:image/png');

    await page.click('.image-preview-overlay', { position: { x: 2, y: 2 } });
    await page.waitForFunction(() => !document.querySelector('.image-preview-overlay'));
    await page.close();
  });
});
