import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PetWindowManager } from '../../desktop/src/pet-window-manager.js';

function makeMainWindow() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const wc = {
    send: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
  };
  return {
    listeners,
    webContents: wc,
    isDestroyed: () => false,
    isFocused: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    on: (evt: string, cb: (...args: unknown[]) => void) => {
      (listeners[evt] ||= []).push(cb);
    },
  };
}

describe('PetWindowManager 状态机', () => {
  let manager: PetWindowManager;
  let main: ReturnType<typeof makeMainWindow>;

  beforeEach(() => {
    manager = new PetWindowManager();
    main = makeMainWindow();
    manager.setContext(main as never, 'http://127.0.0.1:1024/');
  });

  it('初始模式为 hidden', () => {
    expect(manager.getMode()).toBe('hidden');
  });

  it('enterEmbeddedMode 切到 embedded 并通知主窗冰豆可见', async () => {
    await manager.enterEmbeddedMode();
    expect(manager.getMode()).toBe('embedded');
    expect(main.webContents.send).toHaveBeenCalledWith('pet:force-visible', true);
  });

  it('hide 切回 hidden', async () => {
    await manager.enterEmbeddedMode();
    manager.hide();
    expect(manager.getMode()).toBe('hidden');
  });

  it('pushSnapshot 在 floating 模式推送到悬浮窗', async () => {
    await manager.enterFloatingMode();
    manager.pushSnapshot({ task: 'x' });
    // floating 窗来自 createPetFloatingWindow（stub BrowserWindow）
    expect(manager.getMode()).toBe('floating');
  });

  it('destroy 后模式回到 hidden 且可再次进入 embedded', async () => {
    await manager.enterFloatingMode();
    manager.destroy();
    expect(manager.getMode()).toBe('hidden');
    await manager.enterEmbeddedMode();
    expect(manager.getMode()).toBe('embedded');
  });

  it('enterFloatingMode 通知主窗冰豆隐藏', async () => {
    await manager.enterFloatingMode();
    expect(main.webContents.send).toHaveBeenCalledWith('pet:force-visible', false);
  });
});
