import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_FILE_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-file.js'),
  'utf-8',
);
const CHAT_PAGE_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/chat-page.js'),
  'utf-8',
);

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

describe('聊天图片粘贴', () => {
  it('源码同时处理 clipboard files、items 与桌面剪贴板回退', () => {
    expect(CHAT_FILE_SOURCE).toContain('collectClipboardImageFiles');
    expect(CHAT_FILE_SOURCE).toContain('tryPasteFromDesktopClipboard');
    expect(CHAT_FILE_SOURCE).toContain('readClipboardImage');
    expect(CHAT_FILE_SOURCE).toContain('looksLikeImagePath');
    expect(CHAT_PAGE_SOURCE).toContain('bindComposerInteractions');
    expect(CHAT_FILE_SOURCE).toContain('waitForPendingImageLoads');
    expect(CHAT_PAGE_SOURCE).toContain('var appendUserMessageNow = !busyAtSend');
    expect(CHAT_PAGE_SOURCE).toContain('function stripNextPrefix');
  });

  it('从 clipboardData.files 收集图片', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<div id="pending-images-preview" class="hidden"></div>');
    await page.addScriptTag({ content: CHAT_FILE_SOURCE });
    const count = await page.evaluate(() => {
      const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
      const clipboardData = {
        files: [file],
        items: [],
        getData: () => '',
      };
      const got = (window as any).ChatFile.collectClipboardImageFiles(clipboardData);
      return got.length;
    });
    expect(count).toBe(1);
    await page.close();
  });

  it('从 items.getAsFile 收集图片', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<div id="pending-images-preview" class="hidden"></div>');
    await page.addScriptTag({ content: CHAT_FILE_SOURCE });
    const count = await page.evaluate(() => {
      const file = new File([new Uint8Array([1, 2, 3])], 'clip.png', { type: 'image/png' });
      const clipboardData = {
        files: [],
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => file,
        }],
        getData: () => '',
      };
      const got = (window as any).ChatFile.collectClipboardImageFiles(clipboardData);
      return got.length;
    });
    expect(count).toBe(1);
    await page.close();
  });

  it('files 与 items 同时有同一张图时只收一份', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<div id="pending-images-preview" class="hidden"></div>');
    await page.addScriptTag({ content: CHAT_FILE_SOURCE });
    const count = await page.evaluate(() => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const fromFiles = new File([bytes], 'shot.png', { type: 'image/png', lastModified: 1 });
      const fromItems = new File([bytes], 'image.png', { type: 'image/png', lastModified: Date.now() });
      const clipboardData = {
        files: [fromFiles],
        items: [{
          kind: 'file',
          type: 'image/png',
          getAsFile: () => fromItems,
        }],
        getData: () => '',
      };
      const got = (window as any).ChatFile.collectClipboardImageFiles(clipboardData);
      return got.length;
    });
    expect(count).toBe(1);
    await page.close();
  });

  it('桌面剪贴板回退：无文本时读 iceDesktop.readClipboardImage', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<div id="pending-images-preview" class="hidden"></div>');
    await page.addScriptTag({ content: CHAT_FILE_SOURCE });
    const consumed = await page.evaluate(() => {
      const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      (window as any).iceDesktop = {
        readClipboardImage: () => ({ mime: 'image/png', base64: pngB64 }),
      };
      (window as any).ChatFile.init({
        elFileStatus: null,
        elFileInput: null,
      });
      return (window as any).ChatFile.tryPasteFromDesktopClipboard({
        getData: () => '',
        files: [],
        items: [],
      });
    });
    expect(consumed).toBe(true);
    await page.waitForFunction(() => (window as any).ChatFile.getPendingImages().length === 1);
    await page.close();
  });

  it('文本像图片路径时仍读取桌面剪贴板图片', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<div id="pending-images-preview" class="hidden"></div>');
    await page.addScriptTag({ content: CHAT_FILE_SOURCE });
    const consumed = await page.evaluate(() => {
      const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      (window as any).iceDesktop = {
        readClipboardImage: () => ({ mime: 'image/png', base64: pngB64 }),
      };
      (window as any).ChatFile.init({
        elFileStatus: null,
        elFileInput: null,
      });
      return (window as any).ChatFile.tryPasteFromDesktopClipboard({
        getData: () => 'C:\\\\Users\\\\a\\\\shot.png',
        files: [],
        items: [],
      });
    });
    expect(consumed).toBe(true);
    await page.close();
  });

  it('waitForPendingImageLoads 在 FileReader 完成后回调', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<div id="pending-images-preview" class="hidden"></div>');
    await page.addScriptTag({ content: CHAT_FILE_SOURCE });
    const ready = await page.evaluate(async () => {
      const file = new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', { type: 'image/png' });
      (window as any).ChatFile.init({ elFileStatus: null, elFileInput: null });
      (window as any).ChatFile.addPendingImage(file);
      await new Promise<void>((resolve) => {
        (window as any).ChatFile.waitForPendingImageLoads(resolve);
      });
      return (window as any).ChatFile.getPendingImages().length;
    });
    expect(ready).toBe(1);
    await page.close();
  });
});
