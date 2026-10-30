import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { classicWindowSource } from './classic-window-source.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODAL_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/modal.ts'),
  'utf-8',
));
const COMMANDS_SOURCE = classicWindowSource(readFileSync(
  path.join(__dirname, '../../src/public/js/chat-commands.ts'),
  'utf-8',
));

const tokenBody = {
  success: true,
  day: { totalTokens: 388 },
  week: { totalTokens: 1000 },
  month: { totalTokens: 2000 },
  byModel: {
    'deepseek-v4.1-flash': { month: { totalTokens: 12 } },
  },
};

const telemetryBody = {
  success: true,
  days: 7,
  log: {
    recall: { count: 33, llmRate: 15, avgMs: 3730, totalSelected: 84 },
    extract: { count: 3, cacheHitRate: 100, avgMs: 25268, totalMemories: 3, skipCount: 6 },
    dream: { count: 1, totalModified: 2, totalDeleted: 1, totalEvicted: 3, avgMs: 80 },
    capEvict: { count: 2, totalFilesEvicted: 5, avgMs: 9 },
  },
  store: {
    totalFiles: 24,
    byType: { project: 9, feedback: 15 },
    avgAgeDays: 7.7,
    maxAgeDays: 41,
  },
  process: {},
};

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

async function loadCommands(page: Page) {
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: MODAL_SOURCE });
  await page.addScriptTag({ content: COMMANDS_SOURCE });
}

function textOf(page: Page, selector: string) {
  return page.locator(selector).textContent();
}

describe('Token 与记忆遥测共用弹层', () => {
  it('切换内容时不新建弹层，过期响应也不会写回', async () => {
    const page = await browser.newPage();
    try {
      await loadCommands(page);
      await page.evaluate(({ tokens, telemetry }) => {
        let tokenCalls = 0;
        const json = (data: unknown) => Promise.resolve({ json: () => Promise.resolve(data) });
        window.fetch = (url: RequestInfo | URL) => {
          const target = String(url);
          if (target.includes('token-usage')) {
            tokenCalls += 1;
            if (tokenCalls === 1) {
              return new Promise((resolve) => {
                (window as unknown as { __releaseTokens?: () => void }).__releaseTokens = () => resolve(json(tokens));
              });
            }
            return json(tokens);
          }
          if (target.includes('telemetry')) return json(telemetry);
          return Promise.reject(new Error(target));
        };
        (window as unknown as { ChatCommands: { handleTokenStats: () => void } }).ChatCommands.handleTokenStats();
        (window as unknown as { __usageOverlay?: Element | null }).__usageOverlay = document.querySelector('.modal-overlay');
      }, { tokens: tokenBody, telemetry: telemetryBody });

      await expect.poll(() => textOf(page, '.modal-panel-title')).toBe('Token 消耗');
      await expect.poll(() => textOf(page, '.modal-panel-desc')).toContain('与会话无关');
      expect(await page.locator('.modal-overlay').count()).toBe(1);

      await page.evaluate(() => {
        (window as unknown as { ChatCommands: { handleTelemetry: () => void } }).ChatCommands.handleTelemetry();
      });

      await expect.poll(() => textOf(page, '.modal-panel-title')).toBe('记忆遥测');
      await expect.poll(() => textOf(page, '.modal-panel-desc')).toContain('最近 7 天');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('召回');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('33 次');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('LLM 15%');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('跳过 6');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('淘汰 3');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('条数淘汰');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('project 9');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('feedback 15');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('7.7 天');
      expect(await page.locator('.modal-overlay').count()).toBe(1);
      expect(await page.locator('[data-usage-view="telemetry"]').getAttribute('aria-pressed')).toBe('true');
      expect(await page.evaluate(() => (
        document.querySelector('.modal-overlay') === (window as unknown as { __usageOverlay?: Element }).__usageOverlay
      ))).toBe(true);

      await page.evaluate(() => {
        (window as unknown as { __releaseTokens: () => void }).__releaseTokens();
      });
      await page.waitForTimeout(80);
      const mid = await textOf(page, '.modal-panel-body');
      expect(mid).toContain('召回');
      expect(mid).not.toContain('最近一天');
      expect(await page.locator('.modal-overlay').count()).toBe(1);

      await page.locator('[data-usage-view="tokens"]').click();
      await expect.poll(() => textOf(page, '.modal-panel-title')).toBe('Token 消耗');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('388');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('最近一天');
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('deepseek-v4.1-flash');
      expect(await page.locator('[data-usage-view="tokens"]').getAttribute('aria-pressed')).toBe('true');
      expect(await page.locator('.modal-overlay').count()).toBe(1);
      expect(await page.evaluate(() => (
        document.querySelector('.modal-overlay') === (window as unknown as { __usageOverlay?: Element }).__usageOverlay
      ))).toBe(true);

      await page.keyboard.press('Escape');
      await expect.poll(() => page.locator('.modal-overlay').count()).toBe(0);

      await page.evaluate(() => {
        (window as unknown as { ChatCommands: { handleTelemetry: () => void } }).ChatCommands.handleTelemetry();
      });
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('记忆库');
      await page.locator('.modal-panel-close').click();
      await expect.poll(() => page.locator('.modal-overlay').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('日志为空时回退到进程内统计，空记忆库有明确空态', async () => {
    const page = await browser.newPage();
    try {
      await loadCommands(page);
      const fallback = {
        success: true,
        days: 7,
        log: {
          recall: { count: 0, llmRate: 0, avgMs: 0, totalSelected: 0 },
          extract: { count: 0, cacheHitRate: 0, avgMs: 0, totalMemories: 0, skipCount: 4 },
          dream: { count: 0, totalModified: 0, totalDeleted: 0, totalEvicted: 0, avgMs: 0 },
          capEvict: { count: 0, totalFilesEvicted: 0, avgMs: 0 },
        },
        store: { totalFiles: 0, byType: {}, avgAgeDays: 0, maxAgeDays: 0 },
        process: {
          totalRecalls: 4,
          llmRecallRate: 25,
          avgRecallMs: 12,
          totalMemoriesSelected: 3,
          totalExtracts: 0,
          totalDreams: 0,
        },
      };
      await page.evaluate((telemetry) => {
        window.fetch = (url: RequestInfo | URL) => {
          const target = String(url);
          if (target.includes('telemetry')) {
            return Promise.resolve({ json: () => Promise.resolve(telemetry) });
          }
          return Promise.reject(new Error(target));
        };
        (window as unknown as { ChatCommands: { handleTelemetry: () => void } }).ChatCommands.handleTelemetry();
      }, fallback);

      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('4 次');
      const body = await textOf(page, '.modal-panel-body');
      expect(body).toContain('LLM 25%');
      expect(body).toContain('关键词 75%');
      expect(body).toContain('选中 3');
      expect(body).toContain('跳过 4');
      expect(body).toContain('暂无');
      expect(body).toContain('尚未创建记忆文件');
      expect(body).not.toContain('条数淘汰');
    } finally {
      await page.close();
    }
  });

  it('失败后仍可切换，其它弹层会替换而不是叠两层', async () => {
    const page = await browser.newPage();
    try {
      await loadCommands(page);
      await page.evaluate((telemetry) => {
        window.fetch = (url: RequestInfo | URL) => {
          const target = String(url);
          if (target.includes('token-usage')) return Promise.reject(new Error('boom'));
          if (target.includes('telemetry')) {
            return Promise.resolve({ json: () => Promise.resolve(telemetry) });
          }
          return Promise.reject(new Error(target));
        };
        (window as unknown as { ChatCommands: { handleTokenStats: () => void } }).ChatCommands.handleTokenStats();
      }, telemetryBody);

      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('统计失败：boom');
      expect(await page.locator('[data-usage-view]').count()).toBe(2);

      await page.locator('[data-usage-view="telemetry"]').click();
      await expect.poll(() => textOf(page, '.modal-panel-body')).toContain('召回');
      expect(await page.locator('.modal-overlay').count()).toBe(1);

      await page.evaluate(() => {
        (window as unknown as { Modal: { panel: (opts: object) => void } }).Modal.panel({
          title: '手机扫码远程控制',
          description: '同一局域网',
          bodyHtml: '<p class="modal-panel-muted">qr</p>',
        });
      });
      await expect.poll(() => textOf(page, '.modal-panel-title')).toBe('手机扫码远程控制');
      expect(await page.locator('.modal-overlay').count()).toBe(1);
      expect(await textOf(page, '.modal-panel-body')).toContain('qr');
      expect(await page.locator('[data-usage-view]').count()).toBe(0);

      await page.evaluate(() => {
        (window as unknown as { ChatCommands: { handleTokenStats: () => void } }).ChatCommands.handleTokenStats();
      });
      await expect.poll(() => textOf(page, '.modal-panel-title')).toBe('Token 消耗');
      expect(await page.locator('.modal-overlay').count()).toBe(1);
      expect(await page.locator('.modal-panel-toolbar').count()).toBe(1);
    } finally {
      await page.close();
    }
  });
});
