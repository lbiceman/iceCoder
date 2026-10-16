/**
 * 每块屏幕一个透明、置顶、点击穿透的浮层，用来画轮盘和问号。
 * 窗口比屏幕少 1 像素，避免资源管理器把它当成全屏程序藏起任务栏。
 */
import path from 'node:path';
import { BrowserWindow, screen, type Display } from 'electron';
import { IPC } from '../constants';
import { cropCssSize } from './geometry';

export interface WheelView {
  show: boolean;
  x: number;
  y: number;
  slice: number | null;
}

export interface MarkerView {
  show: boolean;
  x: number;
  y: number;
  phase: 'wait' | 'loading' | 'answer' | 'error';
  text: string;
  /** 截图框边长，CSS 像素。 */
  crop: number;
}

interface OverlaySlot {
  displayId: number;
  win: BrowserWindow;
  ready: boolean;
  wheel: WheelView | null;
  marker: MarkerView | null;
}

function overlayHtmlPath(): string {
  // 编译产物在 dist/ping/，页面在 desktop/assets（打包后是 asar 根上的 assets）。
  return path.join(__dirname, '..', '..', 'assets', 'ping-overlay.html');
}

function localPoint(display: Display, physicalX: number, physicalY: number): { x: number; y: number } {
  const dip = screen.screenToDipPoint({ x: physicalX, y: physicalY });
  return {
    x: Math.round(dip.x - display.bounds.x),
    y: Math.round(dip.y - display.bounds.y),
  };
}

export interface PingOverlay {
  warm(): void;
  showWheel(originX: number, originY: number, cursorX: number, cursorY: number, slice: number | null): void;
  setWheelSlice(slice: number | null): void;
  hideWheel(): void;
  showMarker(originX: number, originY: number, phase: MarkerView['phase'], text: string, cropPx: number): void;
  hideMarker(): void;
  /** 截图前藏起浮层，避免把轮盘拍进去。 */
  hideForCapture(): void;
  reveal(): void;
  destroy(): void;
}

export function createPingOverlay(onDisplaysChanged: () => void): PingOverlay {
  const slots = new Map<number, OverlaySlot>();
  let capturing = false;
  let listenerBound = false;
  let refreshing = false;
  const onDisplayChange = (): void => {
    if (refreshing) return;
    refreshing = true;
    try {
      destroyWindows();
      warm();
      onDisplaysChanged();
    } finally {
      refreshing = false;
    }
  };

  function bindDisplayListener(): void {
    if (listenerBound) return;
    listenerBound = true;
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);
    screen.on('display-metrics-changed', onDisplayChange);
  }

  function unbindDisplayListener(): void {
    if (!listenerBound) return;
    listenerBound = false;
    screen.removeListener('display-added', onDisplayChange);
    screen.removeListener('display-removed', onDisplayChange);
    screen.removeListener('display-metrics-changed', onDisplayChange);
  }

  function createSlot(display: Display): OverlaySlot {
    const height = Math.max(1, display.bounds.height - 1);
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      roundedCorners: false,
      backgroundColor: '#00000000',
      ...(process.platform === 'win32' ? { type: 'toolbar' as const, thickFrame: false } : {}),
      webPreferences: {
        preload: path.join(__dirname, '..', 'ping-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 窗口一直留着。拖动时再 show / 再置顶，透明窗会闪两下。
    if (typeof win.showInactive === 'function') win.showInactive();
    else win.show();
    const slot: OverlaySlot = { displayId: display.id, win, ready: false, wheel: null, marker: null };
    win.webContents.on('did-finish-load', () => {
      slot.ready = true;
      push(slot);
    });
    void win.loadFile(overlayHtmlPath());
    return slot;
  }

  function warm(): void {
    bindDisplayListener();
    for (const display of screen.getAllDisplays()) {
      if (slots.has(display.id)) continue;
      slots.set(display.id, createSlot(display));
    }
  }

  function slotFor(physicalX: number, physicalY: number): { slot: OverlaySlot; local: { x: number; y: number }; display: Display } | null {
    const dip = screen.screenToDipPoint({ x: physicalX, y: physicalY });
    const display = screen.getDisplayNearestPoint(dip);
    let slot = slots.get(display.id);
    if (!slot || slot.win.isDestroyed()) {
      slot = createSlot(display);
      slots.set(display.id, slot);
    }
    return { slot, local: localPoint(display, physicalX, physicalY), display };
  }

  function push(slot: OverlaySlot): void {
    if (!slot.ready || slot.win.isDestroyed()) return;
    slot.win.webContents.send(IPC.SCREEN_PING_WHEEL, slot.wheel ?? { show: false, x: 0, y: 0, slice: null });
    slot.win.webContents.send(IPC.SCREEN_PING_MARKER, slot.marker ?? {
      show: false, x: 0, y: 0, phase: 'loading', text: '', crop: 0,
    });
  }

  function revealSlot(slot: OverlaySlot): void {
    if (capturing || slot.win.isDestroyed()) return;
    if (!slot.win.isVisible()) {
      if (typeof slot.win.showInactive === 'function') slot.win.showInactive();
      else slot.win.show();
    }
    push(slot);
  }

  function syncAll(): void {
    for (const slot of slots.values()) revealSlot(slot);
  }

  function clearWheel(): void {
    for (const slot of slots.values()) slot.wheel = null;
  }

  function clearMarker(): void {
    for (const slot of slots.values()) slot.marker = null;
  }

  function destroyWindows(): void {
    for (const slot of slots.values()) {
      if (!slot.win.isDestroyed()) slot.win.destroy();
    }
    slots.clear();
  }

  return {
    warm,
    showWheel(originX, originY, _cursorX, _cursorY, slice) {
      clearMarker();
      clearWheel();
      const found = slotFor(originX, originY);
      if (!found) return;
      found.slot.wheel = { show: true, x: found.local.x, y: found.local.y, slice };
      syncAll();
    },
    /** 轮盘已经钉住，只改高亮的扇区，不再移动、不再重播打开动画。 */
    setWheelSlice(slice: number | null): void {
      for (const slot of slots.values()) {
        if (!slot.wheel?.show || slot.wheel.slice === slice) continue;
        slot.wheel = { ...slot.wheel, slice };
        push(slot);
      }
    },
    hideWheel() {
      clearWheel();
      syncAll();
    },
    showMarker(originX, originY, phase, text, cropPx) {
      clearMarker();
      const found = slotFor(originX, originY);
      if (!found) return;
      found.slot.marker = {
        show: true,
        x: found.local.x,
        y: found.local.y,
        phase,
        text,
        crop: cropCssSize(found.display.scaleFactor, cropPx),
      };
      syncAll();
    },
    hideMarker() {
      clearMarker();
      syncAll();
    },
    hideForCapture() {
      capturing = true;
      for (const slot of slots.values()) {
        if (!slot.win.isDestroyed() && slot.win.isVisible()) slot.win.hide();
      }
    },
    reveal() {
      capturing = false;
      syncAll();
    },
    destroy() {
      capturing = false;
      unbindDisplayListener();
      destroyWindows();
    },
  };
}
