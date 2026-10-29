import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const overlayUrl = pathToFileURL(
  path.join(__dirname, '../../desktop/assets/ping-overlay.html'),
).href;

describe('问号浮层预览', () => {
  it('轮盘和发光问号能画出来', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    try {
      await page.goto(overlayUrl);
      await page.evaluate(() => {
        const preview = (window as unknown as {
          __pingPreview: {
            setWheel: (payload: unknown) => void;
            setMarker: (payload: unknown) => void;
          };
        }).__pingPreview;
        preview.setWheel({ show: true, x: 360, y: 340, slice: 3 });
        preview.setMarker({
          show: true,
          x: 640,
          y: 180,
          phase: 'answer',
          text: '这是发送按钮，回车也能发出去。',
        });
      });
      await page.evaluate(() => { document.body.style.background = '#1b1e26'; });
      await page.locator('#wheel.open').waitFor();
      expect(await page.locator('#wheel .icon').count()).toBe(4);
      expect(await page.locator('.ping-label').textContent()).toBe('PING');
      expect(await page.locator('#wheel .icon.hot .q-art').count()).toBe(1);
      expect(await page.locator('#wheel .icon.is-alert').count()).toBe(1);
      expect(await page.locator('#wheel .icon.is-way').count()).toBe(1);
      expect(await page.locator('#mark .q-art').count()).toBe(1);
      expect(await page.locator('#mark-text').textContent()).toBe('这是发送按钮，回车也能发出去。');
      expect(await page.locator('.wedge.is-q.is-hot').count()).toBe(1);
      const slots = await page.evaluate(() => {
        const wheel = document.getElementById('wheel') as HTMLElement;
        const mid = wheel.getBoundingClientRect();
        const mx = (mid.left + mid.right) / 2;
        const my = (mid.top + mid.bottom) / 2;
        const at = (selector: string) => {
          const box = (wheel.querySelector(selector) as Element).getBoundingClientRect();
          return {
            x: (box.left + box.right) / 2 - mx,
            y: (box.top + box.bottom) / 2 - my,
          };
        };
        return {
          up: at('.icon.is-alert'),
          right: at('.icon.is-way'),
          down: at('.icon[data-slice="2"]'),
          left: at('.icon.is-q'),
        };
      });
      expect(slots.up.y).toBeLessThan(-70);
      expect(Math.abs(slots.up.x)).toBeLessThan(30);
      expect(slots.right.x).toBeGreaterThan(70);
      expect(Math.abs(slots.right.y)).toBeLessThan(30);
      expect(slots.down.y).toBeGreaterThan(70);
      expect(Math.abs(slots.down.x)).toBeLessThan(30);
      expect(slots.left.x).toBeLessThan(-70);
      expect(Math.abs(slots.left.y)).toBeLessThan(30);
      const hover = await page.evaluate(async () => {
        const preview = (window as unknown as {
          __pingPreview: { setWheel: (payload: unknown) => void };
        }).__pingPreview;
        const icon = document.querySelector('#wheel .icon.is-q') as Element;
        const center = () => {
          const box = icon.getBoundingClientRect();
          return {
            x: (box.left + box.right) / 2,
            y: (box.top + box.bottom) / 2,
            w: box.width,
          };
        };
        const wait = () => new Promise((resolve) => { window.setTimeout(resolve, 160); });
        preview.setWheel({ show: true, x: 360, y: 340, slice: null });
        await wait();
        const cold = center();
        preview.setWheel({ show: true, x: 360, y: 340, slice: 3 });
        await wait();
        const hot = center();
        return {
          dx: Math.round((hot.x - cold.x) * 100) / 100,
          dy: Math.round((hot.y - cold.y) * 100) / 100,
          grew: hot.w > cold.w + 2,
        };
      });
      expect(Math.abs(hover.dx)).toBeLessThan(1);
      expect(Math.abs(hover.dy)).toBeLessThan(1);
      expect(hover.grew).toBe(true);
      const aligned = await page.evaluate(() => {
        const mark = document.getElementById('mark') as HTMLElement;
        const art = mark.querySelector('.art') as HTMLElement;
        const measure = () => {
          const anchor = mark.getBoundingClientRect();
          const box = art.getBoundingClientRect();
          return {
            dx: Math.round(((box.left + box.right) / 2 - anchor.left) * 100) / 100,
            dy: Math.round((box.bottom - anchor.top) * 100) / 100,
          };
        };
        const first = measure();
        return new Promise<{ first: { dx: number; dy: number }; later: { dx: number; dy: number } }>((resolve) => {
          window.setTimeout(() => resolve({ first, later: measure() }), 450);
        });
      });
      expect(aligned.first).toEqual({ dx: 0, dy: 0 });
      expect(aligned.later).toEqual(aligned.first);
      const afterFrame = await page.evaluate(() => {
        const preview = (window as unknown as {
          __pingPreview: { setMarker: (payload: unknown) => void };
        }).__pingPreview;
        const mark = document.getElementById('mark') as HTMLElement;
        const before = mark.getBoundingClientRect();
        preview.setMarker({
          frameOnly: true,
          cropW: 200,
          cropH: 120,
        });
        preview.setMarker({
          show: true,
          x: 12,
          y: 12,
          phase: 'answer',
          text: '这是发送按钮，回车也能发出去。',
        });
        const after = mark.getBoundingClientRect();
        const frame = document.getElementById('crop-frame')!.getBoundingClientRect();
        return {
          sameLeft: before.left === after.left,
          sameTop: before.top === after.top,
          frame: document.getElementById('crop-frame')?.classList.contains('on') === true,
          centerX: Math.round(((frame.left + frame.right) / 2 - after.left) * 100) / 100,
          centerY: Math.round(((frame.top + frame.bottom) / 2 - after.top) * 100) / 100,
        };
      });
      expect(afterFrame.sameLeft).toBe(true);
      expect(afterFrame.sameTop).toBe(true);
      expect(afterFrame.frame).toBe(true);
      expect(afterFrame.centerX).toBe(0);
      expect(afterFrame.centerY).toBe(0);
      await page.evaluate(() => {
        const preview = (window as unknown as {
          __pingPreview: { spawnSignal: (payload: unknown) => void };
        }).__pingPreview;
        for (const slice of [0, 1, 2]) {
          preview.spawnSignal({ x: 160 + slice * 140, y: 520, slice });
        }
        preview.spawnSignal({ x: 80, y: 520, slice: 3 });
      });
      expect(await page.locator('#signals .ping').count()).toBe(3);
      expect(await page.locator('#signals .art svg').count()).toBe(3);
      await page.screenshot({ path: path.join(os.tmpdir(), 'ice-ping-preview.png') });
    } finally {
      await browser.close();
    }
  });
});