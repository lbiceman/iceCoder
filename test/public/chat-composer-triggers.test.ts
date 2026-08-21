import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const FILE_REF_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-file-ref.js'), 'utf-8');
const SKILLS_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-skills.js'), 'utf-8');
const DROPDOWN_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-dropdown.js'), 'utf-8');
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

describe('输入框 @ # 触发与工具栏', () => {
  it('源码在中文后也可触发 @/#，且文件按钮覆盖原生 input', () => {
    expect(FILE_REF_SOURCE).toContain('/@([^\\s@]*)$/');
    expect(SKILLS_SOURCE).toContain('/#([^\\s#]*)$/');
    expect(PAGE_SOURCE).toContain('composer-file-input');
    expect(PAGE_SOURCE).toContain('bindComposerInteractions');
    expect(PAGE_SOURCE).toContain('function stripNextPrefix');
    expect(PAGE_SOURCE).toContain('var appendUserMessageNow = !busyAtSend');
    expect(PAGE_SOURCE).toContain('addOptimistic');
    expect(PAGE_SOURCE).toContain('sendOpts.images = msgImages');
    expect(PAGE_SOURCE).toContain('waitForPendingImageLoads');
    expect(PAGE_SOURCE).not.toContain('sendOpts.source = \'explicit\'');
  });

  it('中文后输入 @ 会打开文件选择器', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<textarea id="t"></textarea><div id="file-ref-chips-bar"></div>');
    await page.addScriptTag({ content: FILE_REF_SOURCE });
    const opened = await page.evaluate(async () => {
      (window as any).fetch = () => Promise.resolve({
        json: () => Promise.resolve({
          success: true,
          dir: 'E:/ws',
          entries: [{ name: 'a.ts', path: 'E:/ws/a.ts', isDirectory: false, relativePath: 'a.ts' }],
        }),
      });
      const ta = document.getElementById('t') as HTMLTextAreaElement;
      (window as any).ChatFileRef.init();
      (window as any).ChatFileRef.setAnchor(ta);
      (window as any).ChatFileRef.initFileComposer(ta, document.getElementById('file-ref-chips-bar'));
      ta.value = '配合@';
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      (window as any).ChatFileRef.handleInput(ta.value, ta);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return (window as any).ChatFileRef.isOpen();
    });
    expect(opened).toBe(true);
    await page.close();
  });

  it('中文后输入 # 会打开技能下拉', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await page.setContent('<textarea id="t"></textarea><div class="composer-input" id="anchor"></div>');
    await page.addScriptTag({ content: DROPDOWN_SOURCE });
    await page.addScriptTag({ content: SKILLS_SOURCE });
    const opened = await page.evaluate(() => {
      (window as any).ChatSkills.setAnchor(document.getElementById('anchor'));
      const ta = document.getElementById('t') as HTMLTextAreaElement;
      ta.value = '配合#';
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      (window as any).ChatSkills.handleInput(ta.value, ta);
      return (window as any).ChatSkills.isOpen();
    });
    expect(opened).toBe(true);
    await page.close();
  });
});
