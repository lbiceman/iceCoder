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

function bucket(
  key: string,
  timestamp: number,
  total: number,
  byModel: Record<string, ReturnType<typeof emptyTotals>>,
  turns = total > 0 ? 1 : 0,
) {
  const input = Math.round(total * 0.8);
  const output = total - input;
  return {
    key,
    timestamp,
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    turns,
    byModel,
  };
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function dateKey(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function samplePayload(now = Date.now()) {
  const hour = 3_600_000;
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const ts = now - (23 - i) * hour;
    const d = new Date(ts);
    d.setMinutes(0, 0, 0);
    const key = `${dateKey(d)}T${pad2(d.getHours())}:00`;
    const total = i === 23 ? 1200 : 0;
    return bucket(key, d.getTime(), total, total ? { 'gpt-4o': emptyTotals(total, 900, 300) } : {});
  });
  const daily = Array.from({ length: 31 }, (_, i) => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (30 - i));
    const key = dateKey(d);
    const gpt = i >= 24 ? 1000 + i : 0;
    const ds = i >= 26 ? 400 : 0;
    const byModel: Record<string, ReturnType<typeof emptyTotals>> = {};
    if (gpt) byModel['gpt-4o'] = emptyTotals(gpt, gpt - 100, 100);
    if (ds) byModel['DeepSeek-V3.2'] = emptyTotals(ds, ds - 40, 40);
    return bucket(key, d.getTime(), gpt + ds, byModel, (gpt ? 1 : 0) + (ds ? 1 : 0));
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
      'html,body,#root{height:100%;margin:0;}' +
      ':root{' +
        '--surface-page:#111;--bg-card:#1a1a1d;--bg-secondary:#0a0a0b;--bg-hover:#222;' +
        '--text-primary:#fff;--text-secondary:#aaa;--text-muted:#888;' +
        '--border-color:#333;--border-subtle:#2a2a2a;--border-strong:#555;' +
        '--radius:10px;--radius-lg:14px;--radius-pill:9999px;' +
        '--shadow-sm:none;--shadow-md:none;--transition:180ms ease;--transition-fast:120ms ease;' +
        '--chart-1:#6d8cff;--chart-2:#5ec8a8;--chart-3:#e0b56a;' +
      '}' +
      STATS_CSS +
    '</style></head><body>' +
      '<div id="root" style="width:1100px;height:800px"></div>' +
    '</body></html>',
  );
  await page.addScriptTag({ content: STATS_JS });
  await page.evaluate((data) => {
    const auxDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (6 - i));
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { key, timestamp: d.getTime() };
    });
    window.fetch = (input: RequestInfo) => {
      const url = String(input);
      if (url.includes('/api/memory/telemetry')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            log: {
              recall: { count: 4, llmRate: 50, avgMs: 10, totalSelected: 8 },
              extract: { count: 2, cacheHitRate: 0, avgMs: 5, totalMemories: 3, skipCount: 1, skipReasons: {} },
              dream: { count: 1, totalModified: 2, totalDeleted: 0, totalEvicted: 0, avgMs: 20 },
            },
            store: { totalFiles: 9 },
            series: auxDays.map((row, i) => ({
              ...row,
              recall: i === 6 ? 4 : 0,
              extract: i === 5 ? 2 : 0,
              dream: i === 6 ? 1 : 0,
            })),
          }),
        } as Response);
      }
      if (url.includes('/api/supervisor/events')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            executionMode: {
              enter: 3,
              exit: 1,
              byMode: { forced: 3 },
              bySignal: { tool_failure: 2, multi_write: 1 },
              series: auxDays.map((row, i) => ({
                ...row,
                enter: i === 6 ? 3 : 0,
                exit: i === 4 ? 1 : 0,
              })),
            },
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(data),
      } as Response);
    };
    (window as unknown as { StatsPage: { render: (el: HTMLElement) => void } })
      .StatsPage.render(document.getElementById('root') as HTMLElement);
  }, payload);
  await page.waitForSelector('[data-chart="trend"] svg');
  await page.waitForSelector('[data-role="memory-metrics"] .stats-aux-metric-value');
  await page.waitForSelector('[data-chart="memory"] svg');
  await page.waitForSelector('[data-chart="supervisor"] svg');
}

describe('统计页 Token 图表', () => {
  it('上排 Token 卡，下排记忆与监管统计，并可切换时间范围', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    const now = Date.now();
    const payload = samplePayload(now);
    await loadStats(page, payload);

    const snapshot = await page.evaluate(() => {
      const root = document.querySelector('.stats-root') as HTMLElement | null;
      const main = document.querySelector('.stats-main') as HTMLElement | null;
      return {
        trendStrokes: document.querySelectorAll('[data-chart="trend"] .stats-area-stroke').length,
        trendFills: document.querySelectorAll('[data-chart="trend"] .stats-area-fill').length,
        trendMetrics: document.querySelectorAll('[data-role="trend-metrics"] .stats-aux-metric').length,
        model: document.querySelectorAll('[data-chart="model"]').length,
        turns: document.querySelectorAll('[data-chart="turns"]').length,
        split: document.querySelectorAll('.stats-split').length,
        reserve: document.querySelectorAll('.stats-reserve').length,
        labels: [...document.querySelectorAll('.stats-card-label')].map((el) => el.textContent),
        memoryRead: document.querySelector('[data-role="memory-metrics"] .stats-aux-metric-value')?.textContent,
        memoryStrokes: document.querySelectorAll('[data-chart="memory"] .stats-area-stroke').length,
        memoryFills: document.querySelectorAll('[data-chart="memory"] .stats-area-fill').length,
        supervisorStrokes: document.querySelectorAll('[data-chart="supervisor"] .stats-area-stroke').length,
        supervisorFills: document.querySelectorAll('[data-chart="supervisor"] .stats-area-fill').length,
        supervisorEnter: document.querySelector('[data-role="supervisor-enter"]')?.textContent,
        io: document.querySelectorAll('[data-chart="io-in"], [data-chart="io-out"]').length,
        rangeLabels: [...document.querySelectorAll('.stats-range-btn')].map((el) => el.textContent),
        table: document.querySelectorAll('.stats-table').length,
        overflow: main ? getComputedStyle(main).overflow : '',
        rootOverflow: root ? getComputedStyle(root).overflow : '',
      };
    });
    expect(snapshot.trendStrokes).toBeGreaterThan(0);
    expect(snapshot.trendFills).toBe(0);
    expect(snapshot.trendMetrics).toBe(3);
    expect(snapshot.model).toBe(0);
    expect(snapshot.turns).toBe(0);
    expect(snapshot.split).toBe(1);
    expect(snapshot.reserve).toBe(0);
    expect(snapshot.labels).toEqual(['Token 消耗', '记忆', '监管']);
    expect(snapshot.memoryRead).toBe('4');
    expect(snapshot.memoryStrokes).toBe(3);
    expect(snapshot.memoryFills).toBe(0);
    expect(snapshot.supervisorStrokes).toBe(2);
    expect(snapshot.supervisorFills).toBe(0);
    expect(snapshot.supervisorEnter).toBe('3 次');
    expect(snapshot.io).toBe(0);
    expect(snapshot.rangeLabels).toEqual(['日', '当周', '当月']);
    expect(snapshot.table).toBe(0);
    expect(snapshot.overflow).toBe('hidden');
    expect(snapshot.rootOverflow).toBe('hidden');

    await page.click('.stats-range-btn[data-range="day"]');
    const headerPressed = await page.getAttribute('.stats-range-btn[data-range="day"]', 'aria-pressed');
    expect(headerPressed).toBe('true');
    const dayChart = await page.evaluate(() => document.querySelectorAll('[data-chart="trend"] svg').length);
    expect(dayChart).toBe(1);
  });

  it('切换时间范围时，指标骨架与加载后等高，图表不跳动', async () => {
    const page = await browser.newPage();
    openPages.add(page);
    await loadStats(page, samplePayload());

    const before = await page.evaluate(() => ({
      metric: document.querySelector('[data-role="memory-metrics"] .stats-aux-metric')!.getBoundingClientRect().height,
      supervisor: document.querySelector('[data-role="supervisor-metrics"] .stats-aux-metric')!.getBoundingClientRect().height,
      chart: document.querySelector('[data-chart="memory"]')!.getBoundingClientRect().height,
      supervisorChart: document.querySelector('[data-chart="supervisor"]')!.getBoundingClientRect().height,
    }));

    await page.evaluate(() => {
      const orig = window.fetch.bind(window);
      const pending: Array<() => void> = [];
      (window as unknown as { __releaseAux?: () => void }).__releaseAux = () => {
        pending.splice(0).forEach((run) => run());
      };
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/api/memory/telemetry') || url.includes('/api/supervisor/events')) {
          return new Promise((resolve, reject) => {
            pending.push(() => {
              orig(input, init).then(resolve, reject);
            });
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          });
        }
        return orig(input, init);
      };
    });

    await page.click('.stats-range-btn[data-range="month"]');
    const during = await page.evaluate(() => ({
      skel: document.querySelectorAll('[data-role="memory-metrics"] .stats-aux-metric-sub .stats-skel').length,
      memoryChartSkel: document.querySelectorAll('[data-chart="memory"] .stats-skel-chart').length,
      supervisorChartSkel: document.querySelectorAll('[data-chart="supervisor"] .stats-skel-chart').length,
      memorySvg: document.querySelectorAll('[data-chart="memory"] svg').length,
      supervisorSvg: document.querySelectorAll('[data-chart="supervisor"] svg').length,
      metric: document.querySelector('[data-role="memory-metrics"] .stats-aux-metric')!.getBoundingClientRect().height,
      supervisor: document.querySelector('[data-role="supervisor-metrics"] .stats-aux-metric')!.getBoundingClientRect().height,
      chart: document.querySelector('[data-chart="memory"]')!.getBoundingClientRect().height,
      supervisorChart: document.querySelector('[data-chart="supervisor"]')!.getBoundingClientRect().height,
    }));
    expect(during.skel).toBe(3);
    expect(during.memoryChartSkel).toBe(1);
    expect(during.supervisorChartSkel).toBe(1);
    expect(during.memorySvg).toBe(0);
    expect(during.supervisorSvg).toBe(0);
    expect(Math.abs(during.metric - before.metric)).toBeLessThan(1);
    expect(Math.abs(during.supervisor - before.supervisor)).toBeLessThan(1);
    expect(Math.abs(during.chart - before.chart)).toBeLessThan(1);
    expect(Math.abs(during.supervisorChart - before.supervisorChart)).toBeLessThan(1);

    await page.evaluate(() => {
      (window as unknown as { __releaseAux?: () => void }).__releaseAux?.();
    });
    await page.waitForSelector('[data-chart="memory"] svg');
    await page.waitForSelector('[data-chart="supervisor"] svg');
    const after = await page.evaluate(() => ({
      metric: document.querySelector('[data-role="memory-metrics"] .stats-aux-metric')!.getBoundingClientRect().height,
      chart: document.querySelector('[data-chart="memory"]')!.getBoundingClientRect().height,
      supervisorChart: document.querySelector('[data-chart="supervisor"]')!.getBoundingClientRect().height,
      memorySvg: document.querySelectorAll('[data-chart="memory"] svg').length,
      supervisorSvg: document.querySelectorAll('[data-chart="supervisor"] svg').length,
    }));
    expect(after.memorySvg).toBe(1);
    expect(after.supervisorSvg).toBe(1);
    expect(Math.abs(after.metric - before.metric)).toBeLessThan(1);
    expect(Math.abs(after.chart - before.chart)).toBeLessThan(1);
    expect(Math.abs(after.supervisorChart - before.supervisorChart)).toBeLessThan(1);
  });
});
