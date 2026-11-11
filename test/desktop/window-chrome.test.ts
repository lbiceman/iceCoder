import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  applyWindowCommand,
  mainWindowChromeFields,
  startupDocumentHtml,
  windowChromeKind,
  windowUsesCustomControls,
  WINDOW_CAPTION_HEIGHT,
  type WindowCommandTarget,
} from '../../desktop/src/window-chrome.js';

function fakeWin(patch: Partial<WindowCommandTarget> = {}): WindowCommandTarget {
  return {
    isDestroyed: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    setFullScreen: vi.fn(),
    close: vi.fn(),
    ...patch,
  };
}

describe('主窗口自绘标题栏', () => {
  it('Windows 和 Linux 用系统按钮覆盖层，不自绘三个按钮', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const fields = mainWindowChromeFields(platform);
      expect(fields.frame).toBe(false);
      expect(fields.thickFrame).toBe(true);
      expect(fields.titleBarStyle).toBe('hidden');
      expect(fields.titleBarOverlay).toEqual({
        height: WINDOW_CAPTION_HEIGHT,
        color: '#0e0f12',
        symbolColor: '#e6e8ee',
      });
      expect(windowChromeKind(platform)).toBe('overlay');
      expect(windowUsesCustomControls(platform)).toBe(false);
    }
  });

  it('macOS 保留红绿灯，并落在自绘顶栏高度里', () => {
    const fields = mainWindowChromeFields('darwin');
    expect(fields.frame).toBe(true);
    expect(fields.titleBarStyle).toBe('hiddenInset');
    expect(fields.trafficLightPosition).toEqual({ x: 16, y: 9 });
  });

  it('启动页带最小化、最大化、关闭，应用名会转义', () => {
    const html = startupDocumentHtml('iceCoder', { controls: true });
    expect(html).toContain('data-window-action="minimize"');
    expect(html).toContain('data-window-action="maximize"');
    expect(html).toContain('data-window-action="close"');
    expect(html).toContain('class="window-caption"');
    expect(html).toContain('正在启动 iceCoder');

    const escaped = startupDocumentHtml('<ice>', { controls: false });
    expect(escaped).toContain('&lt;ice&gt;');
    expect(escaped).not.toContain('<ice>');
    expect(escaped).not.toContain('data-window-action="close"');
  });

  it('标题栏只声明 drag，按钮只声明 no-drag，缩放时不再改写命中区域', () => {
    const html = startupDocumentHtml('iceCoder', { controls: true });
    expect(html).toContain('-webkit-app-region:drag');
    expect(html).toContain('-webkit-app-region:no-drag');
    expect(html).not.toContain('regionGen');
    expect(html).not.toContain('resize');
    expect(html).not.toContain("setProperty('-webkit-app-region'");

    const renderer = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/public/js/window-chrome.ts'),
      'utf8',
    );
    expect(renderer).not.toContain('bindDragRegionRefresh');
    expect(renderer).not.toContain('webkit-app-region');
    const css = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/public/css/window-chrome.css'),
      'utf8',
    );
    expect(css).toContain('-webkit-app-region: drag');
    expect(css).toContain('-webkit-app-region: no-drag');
  });

  it('最小化、关闭、最大化与全屏还原', () => {
    const normal = fakeWin();
    applyWindowCommand(normal, 'minimize');
    expect(normal.minimize).toHaveBeenCalledTimes(1);

    const closing = fakeWin();
    applyWindowCommand(closing, 'close');
    expect(closing.close).toHaveBeenCalledTimes(1);

    const grow = fakeWin();
    applyWindowCommand(grow, 'toggle-maximize');
    expect(grow.maximize).toHaveBeenCalledTimes(1);

    const shrink = fakeWin({ isMaximized: () => true });
    applyWindowCommand(shrink, 'toggle-maximize');
    expect(shrink.unmaximize).toHaveBeenCalledTimes(1);
    expect(shrink.maximize).not.toHaveBeenCalled();

    const fullscreen = fakeWin({ isFullScreen: () => true, isMaximized: () => true });
    applyWindowCommand(fullscreen, 'toggle-maximize');
    expect(fullscreen.setFullScreen).toHaveBeenCalledWith(false);
    expect(fullscreen.unmaximize).not.toHaveBeenCalled();

    const gone = fakeWin({ isDestroyed: () => true });
    applyWindowCommand(gone, 'close');
    expect(gone.close).not.toHaveBeenCalled();
  });
});
