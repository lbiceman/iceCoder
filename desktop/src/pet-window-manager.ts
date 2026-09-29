/**
 * pet-window-manager.ts — 冰豆 embedded ↔ floating 状态机
 */
import { BrowserWindow } from 'electron';
import {
  applyFloatingWindowPosition,
  createPetFloatingWindow,
  enableFloatingClickThrough,
  PET_FLOATING_HEIGHT,
  PET_FLOATING_WIDTH,
  revealFloatingWindow,
  setFloatingMousePassthrough,
} from './pet-window';
import { PetDisplayMode } from './constants';
import { writePetFloatingPosition } from './paths';

const FLOATING_LOAD_TIMEOUT_MS = 4000;

export class PetWindowManager {
  private mode: PetDisplayMode = 'hidden';
  private floating: BrowserWindow | null = null;
  private mainWindow: BrowserWindow | null = null;
  private serverBaseUrl = 'http://127.0.0.1:1024';
  private transitionLock = false;
  private lastSnapshot: unknown = null;
  /** 与 iceEtlPrefs.showDesktopPet 对齐。关闭后最小化主窗不再浮出冰豆。 */
  private desktopPetEnabled = true;

  setContext(mainWindow: BrowserWindow, serverBaseUrl: string): void {
    this.mainWindow = mainWindow;
    this.serverBaseUrl = serverBaseUrl.replace(/\/$/, '');
    this.ensureFloatingWindow();
  }

  getMode(): PetDisplayMode {
    return this.mode;
  }

  isDesktopPetEnabled(): boolean {
    return this.desktopPetEnabled;
  }

  /**
   * 同步「桌面宠物」开关。
   * 关闭且当前正在悬浮：收起桌面冰豆，主窗保持最小化。
   * 打开且主窗已在后台：补一次悬浮。
   */
  setDesktopPetEnabled(enabled: boolean): Promise<void> {
    if (this.desktopPetEnabled === enabled) return Promise.resolve();
    this.desktopPetEnabled = enabled;
    if (!enabled) {
      this.concealFloatingPet();
      return Promise.resolve();
    }
    if (!this.isMainBackgrounded()) return Promise.resolve();
    return this.enterFloatingMode();
  }

  /** 主窗可见且未最小化时：embedded 模式。 */
  async enterEmbeddedMode(mainWindow?: BrowserWindow): Promise<void> {
    if (mainWindow) this.mainWindow = mainWindow;
    if (this.isMainMinimized()) return;
    if (this.transitionLock) return;
    this.transitionLock = true;
    try {
      if (this.floating && !this.floating.isDestroyed()) {
        this.floating.hide();
      }
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('pet:force-visible', true);
      }
      this.mode = 'embedded';
    } finally {
      this.transitionLock = false;
    }
  }

  /** 主窗最小化/隐藏/收托盘时：floating 模式。桌面宠物关闭时只保持窗口最小化。 */
  async enterFloatingMode(mainWindow?: BrowserWindow): Promise<void> {
    if (mainWindow) this.mainWindow = mainWindow;
    if (!this.desktopPetEnabled) {
      this.concealFloatingPet();
      return;
    }
    if (this.transitionLock) return;
    this.transitionLock = true;
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('pet:force-visible', false);
      }

      this.ensureFloatingWindow();
      await this.waitUntilFloatingLoaded();

      if (!this.floating || this.floating.isDestroyed()) return;

      if (this.isMainRestoredVisible()) {
        this.floating.hide();
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('pet:force-visible', true);
        }
        this.mode = 'embedded';
        return;
      }

      if (!this.desktopPetEnabled) {
        this.concealFloatingPet();
        return;
      }

      applyFloatingWindowPosition(this.floating);
      this.pushSnapshotToFloating();
      this.floating.webContents.send('pet:mode', 'floating');
      revealFloatingWindow(this.floating);
      enableFloatingClickThrough(this.floating);
      this.mode = 'floating';
    } finally {
      this.transitionLock = false;
    }
  }

  hide(): void {
    if (this.floating && !this.floating.isDestroyed()) {
      this.floating.hide();
    }
    this.mode = 'hidden';
  }

  /** 退出应用时销毁悬浮窗。 */
  destroy(): void {
    if (this.floating && !this.floating.isDestroyed()) {
      this.floating.removeAllListeners('moved');
      this.floating.removeAllListeners('closed');
      this.floating.destroy();
      this.floating = null;
    }
    this.mode = 'hidden';
  }

  pushSnapshot(snapshot: unknown): void {
    this.lastSnapshot = snapshot;
    if (this.mode === 'floating') this.pushSnapshotToFloating();
  }

  moveFloatingBy(dx: number, dy: number): void {
    if (!this.floating || this.floating.isDestroyed()) return;
    const [x, y] = this.floating.getPosition();
    this.floating.setPosition(Math.round(x + dx), Math.round(y + dy));
  }

  setFloatingMousePassthrough(passthrough: boolean): void {
    if (!this.floating || this.floating.isDestroyed()) return;
    setFloatingMousePassthrough(this.floating, passthrough);
  }

  private isMainMinimized(): boolean {
    return !!(this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.isMinimized());
  }

  /** 主窗最小化或被 hide，此时才允许把冰豆浮到桌面。 */
  private isMainBackgrounded(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
    if (this.mainWindow.isMinimized()) return true;
    return !this.mainWindow.isVisible();
  }

  /** 收起悬浮窗。主窗若已最小化则保持最小化，不主动还原。 */
  private concealFloatingPet(): void {
    if (this.floating && !this.floating.isDestroyed()) {
      this.floating.hide();
    }
    if (this.mode === 'floating' || this.isMainBackgrounded()) {
      this.mode = 'hidden';
    }
  }

  private isMainRestoredVisible(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false;
    if (this.mainWindow.isMinimized()) return false;
    return this.mainWindow.isVisible();
  }

  private ensureFloatingWindow(): void {
    if (this.floating && !this.floating.isDestroyed()) return;
    this.floating = createPetFloatingWindow({ serverBaseUrl: this.serverBaseUrl });
    this.attachFloatingHandlers(this.floating);
  }

  private async waitUntilFloatingLoaded(): Promise<void> {
    const win = this.floating;
    if (!win || win.isDestroyed()) return;
    const wc = win.webContents;
    if (typeof wc.isLoading === 'function' && !wc.isLoading()) return;

    await Promise.race([
      new Promise<void>((resolve) => {
        wc.once('did-finish-load', () => resolve());
      }),
      new Promise<void>((resolve) => {
        wc.once('did-fail-load', () => resolve());
      }),
      new Promise<void>((resolve) => {
        setTimeout(resolve, FLOATING_LOAD_TIMEOUT_MS);
      }),
    ]);
  }

  private pushSnapshotToFloating(): void {
    if (!this.lastSnapshot || !this.floating || this.floating.isDestroyed()) return;
    this.floating.webContents.send('pet:state-snapshot', this.lastSnapshot);
  }

  private attachFloatingHandlers(win: BrowserWindow): void {
    win.on('moved', () => {
      const [x, y] = win.getPosition();
      writePetFloatingPosition({
        x,
        y,
        w: PET_FLOATING_WIDTH,
        h: PET_FLOATING_HEIGHT,
      });
    });
    win.on('closed', () => {
      this.floating = null;
      this.mode = 'hidden';
    });
    win.webContents.on('did-finish-load', () => {
      if (this.mode !== 'floating' || !this.floating || this.floating.isDestroyed()) return;
      this.pushSnapshotToFloating();
      this.floating.webContents.send('pet:mode', 'floating');
    });
  }
}
