import { describe, expect, it, vi } from 'vitest';
import {
  applyWindowCommand,
  mainWindowChromeFields,
  startupDocumentHtml,
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
  it('Windows 和 Linux 去掉系统标题栏', () => {
    expect(mainWindowChromeFields('win32').frame).toBe(false);
    expect(mainWindowChromeFields('linux').frame).toBe(false);
    expect(mainWindowChromeFields('win32').thickFrame).toBe(true);
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
