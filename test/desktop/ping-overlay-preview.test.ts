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
        preview.setWheel({ show: true, x: 360, y: 340, slice: 6 });
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
      expect(await page.locator('.ping-label').textContent()).toBe('PING');
      expect(await page.locator('#wheel .icon.hot .q-art').count()).toBe(1);
      expect(await page.locator('#mark .q-art').count()).toBe(1);
      expect(await page.locator('#mark-text').textContent()).toBe('这是发送按钮，回车也能发出去。');
      expect(await page.locator('.wedge.is-q.is-hot').count()).toBe(1);
      await page.screenshot({ path: path.join(os.tmpdir(), 'ice-ping-preview.png') });
    } finally {
      await browser.close();
    }
  });
});