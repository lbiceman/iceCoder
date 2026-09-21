import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, '../../src/public');
const STATS_JS = readFileSync(path.join(publicRoot, 'js/stats-page.js'), 'utf-8');
const STATS_CSS = readFileSync(path.join(publicRoot, 'css/stats.css'), 'utf-8');

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

function emptyTotals(total = 0, input = 0, output = 0) {
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function bucket(key: string, timestamp: number, total: number, byModel: Record<string, ReturnType<typeof emptyTotals>>) {
  const input = Math.round(total * 0.8);
  const output = total - input;
  return {
    key,
    timestamp,
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    byModel,
  };
}

function samplePayload() {
  const now = Date.now();
  const hour = 3_600_000;
  const day = 86_400_000;
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const ts = now - (23 - i) * hour;
    const d = new Date(ts);
    d.setMinutes(0, 0, 0);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:00`;
    const total = i === 23 ? 1200 : 0;
    return bucket(key, d.getTime(), total, total ? { 'gpt-4o': emptyTotals(total, 900, 300) } : {});
  });
  const daily = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (29 - i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const gpt = i >= 23 ? 1000 + i : 0;
    const ds = i >= 25 ? 400 : 0;
    const byModel: Record<string, ReturnType<typeof emptyTotals>> = {};
    if (gpt) byModel['gpt-4o'] = emptyTotals(gpt, gpt - 100, 100);
    if (ds) byModel['DeepSeek-V3.2'] = emptyTotals(ds, ds - 40, 40);
    return bucket(key, d.getTime(), gpt + ds, byModel);
  });
  return {
    success: true,
    day: emptyTotals(1200, 900, 300),
    week: emptyTotals(8000, 6400, 1600),
    month: emptyTotals(20000, 16000, 4000),
    all: emptyTotals(25000, 20000, 5000),
    byModel: {
      'gpt-4o': {
        day: emptyTotals(1200, 900, 300),
        week: emptyTotals(5000, 4000, 1000),
        month: emptyTotals(15000, 12000, 3000),
        all: emptyTotals(18000, 14400, 3600),
      },
      'DeepSeek-V3.2': {
        day: emptyTotals(0, 0, 0),
        week: emptyTotals(3000, 2400, 600),
        month: emptyTotals(5000, 4000, 1000),
        all: emptyTotals(7000, 5600, 1400),
      },
    },
    series: { hourly, daily },
  };
}

async function loadStats(page: Page, payload: Record<string, unknown>) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(
    '<!DOCTYPE html><html data-theme="dark"><head><style>' +
      ':root{' +
        '--surface-page:#111;--bg-card:#1a1a1d;--bg-secondary:#0a0a0b;--bg-hover:#222;' +
        '--text-primary:#fff;--text-secondary:#aaa;--text-muted:#888;' +
        '--border-color:#333;--border-subtle:#2a2a2a;--border-strong:#555;' +
        '--radius:10px;--radius-lg:14px;--radius-pill:9999px;' +
        '--shadow-sm:none;--shadow-md:none;--transition:180ms ease;--transition-fast:120ms ease;' +
        '--chart-1:#6d8cff;--chart-2:#4ade80;--chart-3:#fbbf24;--chart-4:#c084fc;--chart-5:#fb7185;' +
      '}' +
      STATS_CSS +
    '</style></head><body>' +
      '<div id="root" style="width:1100px;height:900px"></div>' +
    '</body></html>',
  );
  await page.addScriptTag({ content: STATS_JS });
  await page.evaluate((data) => {
    window.fetch = () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(data),
    } as Response);
    (window as unknown as { StatsPage: { render: (el: HTMLElement) => void } })
      .StatsPage.render(document.getElementById('root') as HTMLElement);
  }, payload);
  await page.waitForSelector('.stats-kpi-value');
}

describe('统计页 Token 图表', () => {
  it('展示滚动窗口 KPI、模型表和面积图', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadStats(page, samplePayload());

    const kpis = await page.locator('.stats-kpi-value').allTextContents();
    expect(kpis.join(' ')).toContain('1,200');
    expect(kpis.join(' ')).toContain('8,000');
    expect(kpis.join(' ')).toContain('20,000');
    expect(kpis.join(' ')).toContain('25,000');

    const snapshot = await page.evaluate(() => {
      return {
        trendPaths: document.querySelectorAll('[data-chart="trend"] .stats-area-fill').length,
        ioPaths: document.querySelectorAll('[data-chart="io"] .stats-area-fill').length,
        models: Array.from(document.querySelectorAll('.stats-table-name')).map((el) => el.textContent || ''),
        bars: document.querySelectorAll('.stats-bar-row').length,
        modelPaths: document.querySelectorAll('[data-chart="model"] .stats-area-fill').length,
      };
    });
    expect(snapshot.trendPaths).toBeGreaterThan(0);
    expect(snapshot.ioPaths).toBeGreaterThan(0);
    expect(snapshot.modelPaths).toBeGreaterThan(0);
    expect(snapshot.models).toContain('gpt-4o');
    expect(snapshot.models).toContain('DeepSeek-V3.2');
    expect(snapshot.bars).toBe(0);

    await page.click('.stats-range-btn[data-range="day"]');
    const pressed = await page.getAttribute('.stats-range-btn[data-range="day"]', 'aria-pressed');
    expect(pressed).toBe('true');
    const dayChart = await page.evaluate(() => document.querySelectorAll('[data-chart="trend"] svg').length);
    expect(dayChart).toBe(1);
  });
});
