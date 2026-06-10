/**
 * pet-window-manager.ts — 冰豆 embedded ↔ floating 状态机
 */
import { BrowserWindow } from 'electron';
import {
  applyFloatingWindowPosition,
  createPetFloatingWindow,
  PET_FLOATING_HEIGHT,
  PET_FLOATING_WIDTH,
} from './pet-window';
import { PetDisplayMode } from './constants';
import { writePetFloatingPosition } from './paths';

export class PetWindowManager {
  private mode: PetDisplayMode = 'hidden';
  private floating: BrowserWindow | null = null;
  private mainWindow: BrowserWindow | null = null;
  private serverBaseUrl = 'http://127.0.0.1:1024';
  private transitionLock = false;
  private lastSnapshot: unknown = null;

  setContext(mainWindow: BrowserWindow, serverBaseUrl: string): void {
    this.mainWindow = mainWindow;
    this.serverBaseUrl = serverBaseUrl.replace(/\/$/, '');
  }

  getMode(): PetDisplayMode {
    return this.mode;
  }

  /** 主窗可见时：embedded 模式。 */
  async enterEmbeddedMode(mainWindow?: BrowserWindow): Promise<void> {
    if (mainWindow) this.mainWindow = mainWindow;
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

  /** 主窗最小化/隐藏/收托盘时：floating 模式。 */
  async enterFloatingMode(mainWindow?: BrowserWindow): Promise<void> {
    if (mainWindow) this.mainWindow = mainWindow;
    if (this.transitionLock) return;
    this.transitionLock = true;
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('pet:force-visible', false);
      }

      if (!this.floating || this.floating.isDestroyed()) {
        this.floating = createPetFloatingWindow({ serverBaseUrl: this.serverBaseUrl });
        this.attachFloatingHandlers(this.floating);
        await new Promise<void>((resolve) => {
          this.floating!.webContents.once('did-finish-load', () => resolve());
        });
      }

      applyFloatingWindowPosition(this.floating);

      if (this.lastSnapshot) {
        this.floating.webContents.send('pet:state-snapshot', this.lastSnapshot);
      }
      this.floating.webContents.send('pet:mode', 'floating');
      this.floating.show();
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
    if (this.mode === 'floating' && this.floating && !this.floating.isDestroyed()) {
      this.floating.webContents.send('pet:state-snapshot', snapshot);
    }
  }

  moveFloatingBy(dx: number, dy: number): void {
    if (!this.floating || this.floating.isDestroyed()) return;
    const [x, y] = this.floating.getPosition();
    this.floating.setPosition(Math.round(x + dx), Math.round(y + dy));
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
  }
}
