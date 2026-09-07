import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const STEPPER_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-reasoning-stepper.js'), 'utf-8');
const WS_SOURCE = readFileSync(path.join(publicRoot, 'js/chat-websocket.js'), 'utf-8');
const CONFIG_PANEL_SOURCE = readFileSync(path.join(publicRoot, 'js/config-model-panel.js'), 'utf-8');

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

const STEPPER_HTML = [
  '<div class="reasoning-stepper" id="reasoning-stepper" role="slider"',
  ' aria-valuemin="0" aria-valuemax="3" aria-valuenow="1" data-level="medium" tabindex="0">',
  '<span class="reasoning-stepper-track"><span class="reasoning-stepper-bar"></span></span>',
  '</div>',
].join('');

describe('推理强度步骤器', () => {
  it('源码会把当前档位写入消息并持久化', () => {
    expect(STEPPER_SOURCE).toContain("var STORAGE_KEY = 'ice-reasoning-effort'");
    expect(STEPPER_SOURCE).toContain('function setLevels');
    expect(STEPPER_SOURCE).toContain('function getLevel');
    expect(WS_SOURCE).toContain('payload.reasoningEffort = reasoningEffort');
    expect(WS_SOURCE).toContain('ChatReasoningStepper.getLevel');
    expect(CONFIG_PANEL_SOURCE).toContain('data-field="reasoningEffort"');
    expect(CONFIG_PANEL_SOURCE).toContain('placeholder="low,high,max"');
  });

  it('按模型配置的档位显示，并恢复上次合法选择', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    const html = `<!DOCTYPE html><html><body>${STEPPER_HTML}</body></html>`;
    await page.route('http://ice.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: html,
    }));
    await page.goto('http://ice.test/');
    await page.evaluate(() => localStorage.setItem('ice-reasoning-effort', 'max'));
    await page.reload();
    await page.addScriptTag({ content: STEPPER_SOURCE });
    const restored = await page.evaluate(() => {
      const root = document.querySelector('#reasoning-stepper');
      const api = (window as unknown as {
        ChatReasoningStepper: {
          init: (el: Element | null) => void;
          setLevels: (raw: string) => void;
          getLevel: () => string | null;
        };
      }).ChatReasoningStepper;
      api.init(root);
      api.setLevels('low,high,max');
      return {
        level: api.getLevel(),
        stored: localStorage.getItem('ice-reasoning-effort'),
        now: root?.getAttribute('aria-valuenow'),
        bars: root?.querySelectorAll('.reasoning-stepper-bar').length,
      };
    });
    expect(restored).toEqual({ level: 'max', stored: 'max', now: '2', bars: 3 });
    await page.close();
  });

  it('未配置档位时隐藏步骤器；旧值不在列表内则回落到中间档', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    const html = `<!DOCTYPE html><html><body>${STEPPER_HTML}</body></html>`;
    await page.route('http://ice.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: html,
    }));
    await page.goto('http://ice.test/');
    await page.evaluate(() => localStorage.setItem('ice-reasoning-effort', 'medium'));
    await page.reload();
    await page.addScriptTag({ content: STEPPER_SOURCE });
    const result = await page.evaluate(() => {
      const root = document.querySelector('#reasoning-stepper');
      const api = (window as unknown as {
        ChatReasoningStepper: {
          init: (el: Element | null) => void;
          setLevels: (raw: string) => void;
          getLevel: () => string | null;
        };
      }).ChatReasoningStepper;
      api.init(root);
      api.setLevels('');
      const empty = {
        level: api.getLevel(),
        hidden: root?.hasAttribute('hidden'),
        bars: root?.querySelectorAll('.reasoning-stepper-bar').length,
      };
      api.setLevels('low,high,max');
      return {
        empty,
        fallback: {
          level: api.getLevel(),
          now: root?.getAttribute('aria-valuenow'),
          hidden: root?.hasAttribute('hidden'),
        },
      };
    });
    expect(result.empty).toEqual({ level: null, hidden: true, bars: 0 });
    expect(result.fallback).toEqual({ level: 'high', now: '1', hidden: false });
    await page.close();
  });
});
