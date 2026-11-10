import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const PREVIEW_SOURCE = classicWindowSource(readFileSync(path.join(publicRoot, 'js/chat-image-preview.ts'), 'utf-8'));
const MAIN_SOURCE = readFileSync(path.join(publicRoot, 'js/main.ts'), 'utf-8');
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
    expect(MAIN_SOURCE).toContain("import './chat-image-preview.ts'");
    expect(CHAT_CSS).toContain('.image-preview-overlay');
    expect(CHAT_CSS).toContain('top: 30px');
    expect(CHAT_CSS).toContain('height: calc(100% - 30px)');
    expect(PREVIEW_SOURCE).toContain('msg-image-thumb');
    expect(PREVIEW_SOURCE).toContain('image-preview-frame');
    expect(CHAT_CSS).toContain('.image-preview-frame');
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

  it('关闭按钮贴在图片右上角', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    openPages.add(page);
    await page.setContent('<!doctype html><html class="ice-window-chrome"><body></body></html>');
    await page.addStyleTag({ content: CHAT_CSS });
    await page.addStyleTag({
      content: '.modal-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;}',
    });
    await page.addScriptTag({ content: PREVIEW_SOURCE });
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 900;
      canvas.height = 560;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#3a6ea5';
        ctx.fillRect(0, 0, 900, 560);
      }
      (window as unknown as { ChatImagePreview: { open: (src: string, alt: string) => void } })
        .ChatImagePreview.open(canvas.toDataURL('image/png'), 'preview');
    });
    await page.waitForFunction(() => {
      const img = document.querySelector('.image-preview-full') as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    });
    const box = await page.evaluate(() => {
      const img = document.querySelector('.image-preview-full') as HTMLElement;
      const close = document.querySelector('.image-preview-close') as HTMLElement;
      const image = img.getBoundingClientRect();
      const button = close.getBoundingClientRect();
      return {
        imageTop: image.top,
        imageRight: image.right,
        imageWidth: image.width,
        imageHeight: image.height,
        buttonTop: button.top,
        buttonRight: button.right,
        buttonBottom: button.bottom,
        viewportHeight: window.innerHeight,
      };
    });
    expect(box.imageHeight).toBeLessThan(box.viewportHeight - 160);
    expect(box.imageWidth).toBeLessThanOrEqual(1200 * 0.8 + 1);
    expect(box.buttonBottom).toBeLessThanOrEqual(box.imageTop);
    expect(box.imageTop - box.buttonBottom).toBeLessThanOrEqual(20);
    expect(Math.abs(box.imageRight - box.buttonRight)).toBeLessThanOrEqual(2);
    await page.close();
  });
});
