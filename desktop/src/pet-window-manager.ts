/**
 * pet-window-manager.ts — 冰豆 embedded ↔ floating 状态机
 *
 * 规则（方案 §11.2）：
 * - embedded 模式：主窗可见，主窗内嵌冰豆可见，悬浮窗隐藏。
 * - floating 模式：主窗最小化/隐藏/收托盘，悬浮窗可见，主窗内嵌冰豆隐藏。
 * - hidden   模式：用户主动关闭悬浮（不常用；预留）。
 *
 * 互斥：切换时**先 hide 一侧再 show 另一侧**，并用 PetDisplayMode 锁。
 */
import { BrowserWindow } from 'electron';
import { createPetFloatingWindow } from './pet-window';
import { PetDisplayMode } from './constants';
import { writePetFloatingPosition } from './paths';

export class PetWindowManager {
  private mode: PetDisplayMode = 'hidden';
  private floating: BrowserWindow | null = null;
  private transitionLock = false;
  /** 来自主窗的最近一次冰豆状态快照（用于 floating 启动时立刻应用）。 */
  private lastSnapshot: unknown = null;
  private onSnapshotToFloating: ((s: unknown) => void) | null = null;

  getMode(): PetDisplayMode {
    return this.mode;
  }

  /** 主窗可见时调用：embedded 模式。 */
  async enterEmbeddedMode(mainWindow: BrowserWindow): Promise<void> {
    if (this.transitionLock) return;
    this.transitionLock = true;
    try {
      // 1) 先 hide 悬浮
      if (this.floating && !this.floating.isDestroyed()) {
        this.floating.hide();
      }
      // 2) 再让主窗冰豆可见
      mainWindow.webContents.send('pet:force-visible', true);
      this.mode = 'embedded';
    } finally {
      this.transitionLock = false;
    }
  }

  /** 主窗最小化/隐藏/收托盘时调用：floating 模式。 */
  async enterFloatingMode(): Promise<void> {
    if (this.transitionLock) return;
    this.transitionLock = true;
    try {
      if (!this.floating || this.floating.isDestroyed()) {
        this.floating = createPetFloatingWindow();
        this.attachFloatingHandlers(this.floating);
        // 等待 ready 后再 show（避免白闪）
        await new Promise<void>((resolve) => {
          this.floating!.webContents.once('did-finish-load', () => resolve());
        });
      }
      // 1) 先让主窗冰豆隐藏
      this.floating.webContents.send('pet:mode', this.mode); // 通知主窗当前模式
      // 主窗冰豆隐藏由 main 广播
      // 2) 再 show 悬浮
      this.floating.show();
      this.floating.focus();
      // 把最近一次快照推给新启动的悬浮窗
      if (this.lastSnapshot && this.onSnapshotToFloating) {
        this.onSnapshotToFloating(this.lastSnapshot);
      }
      this.mode = 'floating';
    } finally {
      this.transitionLock = false;
    }
  }

  /** 完全隐藏两侧。 */
  hide(): void {
    if (this.floating && !this.floating.isDestroyed()) {
      this.floating.hide();
    }
    this.mode = 'hidden';
  }

  /** 主窗冰豆上报状态快照。 */
  pushSnapshot(snapshot: unknown): void {
    this.lastSnapshot = snapshot;
    if (this.mode === 'floating' && this.floating && !this.floating.isDestroyed()) {
      this.floating.webContents.send('pet:state-snapshot', snapshot);
    }
  }

  setSnapshotSink(fn: (s: unknown) => void): void {
    this.onSnapshotToFloating = fn;
  }

  private attachFloatingHandlers(win: BrowserWindow): void {
    win.on('moved', () => {
      const [x, y] = win.getPosition();
      writePetFloatingPosition({ x, y });
    });
    win.on('closed', () => {
      this.floating = null;
      this.mode = 'hidden';
    });
  }
}
