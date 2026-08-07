import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODAL_SOURCE = readFileSync(
  path.join(__dirname, '../../src/public/js/modal.js'),
  'utf-8',
);

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser.close();
}, 30_000);

describe('Modal keyboard safety', () => {
  it('Enter follows the focused cancel button for mandatory confirmations', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body></body></html>');
      await page.addScriptTag({ content: MODAL_SOURCE });
      await page.evaluate(() => {
        (window as any).__modalResult = undefined;
        (window as any).Modal.confirm({
          title: 'Shell 敏感命令确认',
          message: 'rm -rf /tmp/x',
          dangerConfirm: true,
          defaultFocus: 'cancel',
        }).then((value: boolean) => {
          (window as any).__modalResult = value;
        });
      });

      await expect.poll(() => page.evaluate(() => {
        const cancel = document.querySelector('.modal-btn:not(.primary):not(.danger)');
        return document.activeElement === cancel;
      })).toBe(true);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => (window as any).__modalResult)).toBe(false);
    } finally {
      await page.close();
    }
  });

  it('Enter approves only after the confirm button receives focus', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body></body></html>');
      await page.addScriptTag({ content: MODAL_SOURCE });
      await page.evaluate(() => {
        (window as any).__modalResult = undefined;
        (window as any).Modal.confirm({
          title: '确认',
          defaultFocus: 'cancel',
        }).then((value: boolean) => {
          (window as any).__modalResult = value;
        });
      });

      await page.locator('.modal-btn.primary').focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => (window as any).__modalResult)).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('overlay click and Escape do not dismiss the confirm dialog', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent('<html><body></body></html>');
      await page.addScriptTag({ content: MODAL_SOURCE });
      await page.evaluate(() => {
        (window as any).__modalResult = undefined;
        (window as any).Modal.confirm({
          title: '危险操作确认',
          message: 'fs_operation (delete)',
          dangerConfirm: true,
          defaultFocus: 'cancel',
        }).then((value: boolean) => {
          (window as any).__modalResult = value;
        });
      });

      await expect.poll(() => page.locator('.modal-overlay.visible').count()).toBe(1);
      await page.locator('.modal-overlay').click({ position: { x: 8, y: 8 } });
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => (window as any).__modalResult)).toBeUndefined();
      await expect.poll(() => page.locator('.modal-overlay.visible').count()).toBe(1);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(100);
      expect(await page.evaluate(() => (window as any).__modalResult)).toBeUndefined();
      await expect.poll(() => page.locator('.modal-overlay.visible').count()).toBe(1);

      await page.locator('.modal-btn:not(.primary):not(.danger)').click();
      await expect.poll(() => page.evaluate(() => (window as any).__modalResult)).toBe(false);
    } finally {
      await page.close();
    }
  });
});
