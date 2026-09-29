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
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    on: (evt: string, cb: (...args: unknown[]) => void) => {
      (listeners[evt] ||= []).push(cb);
    },
  };
}

function enterFloating(manager: PetWindowManager, main: ReturnType<typeof makeMainWindow>) {
  main.isMinimized.mockReturnValue(true);
  return manager.enterFloatingMode();
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
    await enterFloating(manager, main);
    manager.pushSnapshot({ task: 'x' });
    // floating 窗来自 createPetFloatingWindow（stub BrowserWindow）
    expect(manager.getMode()).toBe('floating');
  });

  it('destroy 后模式回到 hidden 且可再次进入 embedded', async () => {
    await enterFloating(manager, main);
    manager.destroy();
    expect(manager.getMode()).toBe('hidden');
    main.isMinimized.mockReturnValue(false);
    await manager.enterEmbeddedMode();
    expect(manager.getMode()).toBe('embedded');
  });

  it('enterFloatingMode 通知主窗冰豆隐藏', async () => {
    await enterFloating(manager, main);
    expect(main.webContents.send).toHaveBeenCalledWith('pet:force-visible', false);
  });

  it('主窗仍最小化时 enterEmbeddedMode 不把桌面豆藏起来', async () => {
    await enterFloating(manager, main);
    expect(manager.getMode()).toBe('floating');
    main.isMinimized.mockReturnValue(true);
    await manager.enterEmbeddedMode();
    expect(manager.getMode()).toBe('floating');
    expect(main.webContents.send).not.toHaveBeenCalledWith('pet:force-visible', true);
  });

  it('加载过程中主窗已恢复则回到 embedded，不把豆留在桌面', async () => {
    main.isMinimized.mockReturnValue(false);
    main.isVisible.mockReturnValue(true);
    await manager.enterFloatingMode();
    expect(manager.getMode()).toBe('embedded');
  });

  it('关闭桌面宠物后最小化不把冰豆浮到桌面', async () => {
    await manager.setDesktopPetEnabled(false);
    await enterFloating(manager, main);
    expect(manager.isDesktopPetEnabled()).toBe(false);
    expect(manager.getMode()).toBe('hidden');
    expect(main.webContents.send).not.toHaveBeenCalledWith('pet:force-visible', false);
  });

  it('悬浮中关闭桌面宠物会收起冰豆且不还原主窗', async () => {
    await enterFloating(manager, main);
    expect(manager.getMode()).toBe('floating');
    await manager.setDesktopPetEnabled(false);
    expect(manager.getMode()).toBe('hidden');
    expect(main.restore).not.toHaveBeenCalled();
    expect(main.show).not.toHaveBeenCalled();
  });

  it('主窗已最小化时打开桌面宠物会补上悬浮冰豆', async () => {
    await manager.setDesktopPetEnabled(false);
    main.isMinimized.mockReturnValue(true);
    main.isVisible.mockReturnValue(false);
    await manager.setDesktopPetEnabled(true);
    expect(manager.getMode()).toBe('floating');
  });

  it('主窗仍在前台时打开桌面宠物不会提前浮出', async () => {
    await manager.enterEmbeddedMode();
    await manager.setDesktopPetEnabled(false);
    main.isMinimized.mockReturnValue(false);
    main.isVisible.mockReturnValue(true);
    await manager.setDesktopPetEnabled(true);
    expect(manager.getMode()).toBe('embedded');
  });
});
