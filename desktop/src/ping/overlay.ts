/**
 * 每块屏幕一个透明、置顶、点击穿透的浮层，用来画轮盘和问号。
 * 窗口比屏幕少 1 像素，避免资源管理器把它当成全屏程序藏起任务栏。
 */
import path from 'node:path';
import { BrowserWindow, screen, type Display, type Rectangle } from 'electron';
import { IPC } from '../constants';
import { cropCssSize, physicalToLocal, type DisplayMap } from './geometry';

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
  /** 截图框宽高，CSS 像素。问号先出现，框随后才画。 */
  cropW: number;
  cropH: number;
  frame: boolean;
}

interface SignalView {
  x: number;
  y: number;
  slice: number;
}

interface OverlaySlot {
  displayId: number;
  win: BrowserWindow;
  ready: boolean;
  wheel: WheelView | null;
  marker: MarkerView | null;
  pendingSignals: SignalView[];
}

function overlayHtmlPath(): string {
  // 编译产物在 dist/ping/，页面在 desktop/assets（打包后是 asar 根上的 assets）。
  return path.join(__dirname, '..', '..', 'assets', 'ping-overlay.html');
}

/** 比整屏少 1 像素，避免系统把浮层当成全屏程序藏起任务栏。原点仍是这块屏幕的左上角。 */
function overlayBounds(display: Display): Rectangle {
  return {
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: Math.max(1, display.bounds.height - 1),
  };
}

function currentMaps(): DisplayMap[] {
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    dip: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    phys: screen.dipToScreenRect(null, display.bounds),
    scale: display.scaleFactor > 0 && Number.isFinite(display.scaleFactor) ? display.scaleFactor : 1,
  }));
}

export interface PingOverlay {
  warm(): void;
  showWheel(originX: number, originY: number, cursorX: number, cursorY: number, slice: number | null): void;
  setWheelSlice(slice: number | null): void;
  hideWheel(): void;
  showMarker(
    originX: number,
    originY: number,
    phase: MarkerView['phase'],
    text: string,
  ): void;
  /** 问号和黄框已在落点上，只改气泡文字，不重画。 */
  patchMarker(phase: MarkerView['phase'], text: string): void;
  /** 问号已经在落点上，只补矩形，不移动问号。 */
  showCrop(cropWidth: number, cropHeight: number): void;
  hideMarker(): void;
  /** 轮盘上的普通标记。问号不走这里。 */
  showSignal(originX: number, originY: number, slice: number): void;
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
    const bounds = overlayBounds(display);
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
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
    const slot: OverlaySlot = {
      displayId: display.id,
      win,
      ready: false,
      wheel: null,
      marker: null,
      pendingSignals: [],
    };
    // 混合缩放时第一帧的窗口位置会偏，标记就会跟着往右下挪。准备好后再钉一次。
    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.setBounds(overlayBounds(display));
    });
    win.webContents.on('did-finish-load', () => {
      slot.ready = true;
      push(slot);
      flushSignals(slot);
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
    const hit = physicalToLocal(physicalX, physicalY, currentMaps());
    const display = (hit && screen.getAllDisplays().find((item) => item.id === hit.id))
      || screen.getDisplayNearestPoint(screen.screenToDipPoint({ x: physicalX, y: physicalY }));
    let slot = slots.get(display.id);
    if (!slot || slot.win.isDestroyed()) {
      slot = createSlot(display);
      slots.set(display.id, slot);
    }
    const local = hit && hit.id === display.id ? { x: hit.x, y: hit.y } : { x: 0, y: 0 };
    return { slot, local, display };
  }

  /**
   * 窗口已经在屏幕上时不要再 setBounds。
   * 问号截图会先 hide 再 show，系统会把无边框窗口往右下抬。
   * 其它标记不藏窗口，所以位置是稳的。这里在显示之前把原点设好，显示之后不再改。
   */
  function showPinned(slot: OverlaySlot): void {
    if (capturing || slot.win.isDestroyed() || slot.win.isVisible()) return;
    const display = screen.getAllDisplays().find((item) => item.id === slot.displayId);
    if (display) slot.win.setBounds(overlayBounds(display));
    if (typeof slot.win.showInactive === 'function') slot.win.showInactive();
    else slot.win.show();
  }

  function emitSignal(slot: OverlaySlot, payload: SignalView): void {
    if (capturing || !slot.ready || slot.win.isDestroyed()) {
      slot.pendingSignals.push(payload);
      return;
    }
    slot.win.webContents.send(IPC.SCREEN_PING_SIGNAL, payload);
  }

  function flushSignals(slot: OverlaySlot): void {
    if (capturing || !slot.ready || slot.win.isDestroyed()) return;
    const queued = slot.pendingSignals.splice(0);
    for (const payload of queued) slot.win.webContents.send(IPC.SCREEN_PING_SIGNAL, payload);
  }

  function push(slot: OverlaySlot): void {
    if (!slot.ready || slot.win.isDestroyed()) return;
    slot.win.webContents.send(IPC.SCREEN_PING_WHEEL, slot.wheel ?? { show: false, x: 0, y: 0, slice: null });
    slot.win.webContents.send(IPC.SCREEN_PING_MARKER, slot.marker ?? {
      show: false, x: 0, y: 0, phase: 'loading', text: '', cropW: 0, cropH: 0, frame: false,
    });
  }

  function revealSlot(slot: OverlaySlot): void {
    if (capturing || slot.win.isDestroyed()) return;
    showPinned(slot);
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
    showMarker(originX, originY, phase, text) {
      clearMarker();
      const found = slotFor(originX, originY);
      if (!found) return;
      found.slot.marker = {
        show: true,
        x: found.local.x,
        y: found.local.y,
        phase,
        text,
        cropW: 0,
        cropH: 0,
        frame: false,
      };
      syncAll();
    },
    showCrop(cropWidth, cropHeight) {
      for (const slot of slots.values()) {
        if (!slot.marker?.show || capturing || !slot.ready || slot.win.isDestroyed()) continue;
        const display = screen.getAllDisplays().find((item) => item.id === slot.displayId);
        const scale = display && display.scaleFactor > 0 ? display.scaleFactor : 1;
        const cropW = cropCssSize(scale, cropWidth);
        const cropH = cropCssSize(scale, cropHeight);
        slot.marker = { ...slot.marker, frame: true, cropW, cropH };
        // 只带框的尺寸。框画在已经落下的问号上，消息里没有新的坐标。
        slot.win.webContents.send(IPC.SCREEN_PING_MARKER, { frameOnly: true, cropW, cropH });
      }
    },
    patchMarker(phase, text) {
      for (const slot of slots.values()) {
        if (!slot.marker?.show) continue;
        slot.marker = { ...slot.marker, phase, text };
        if (capturing || !slot.ready || slot.win.isDestroyed()) continue;
        slot.win.webContents.send(IPC.SCREEN_PING_MARKER, slot.marker);
      }
    },
    hideMarker() {
      clearMarker();
      syncAll();
    },
    showSignal(originX, originY, slice) {
      const found = slotFor(originX, originY);
      if (!found) return;
      showPinned(found.slot);
      emitSignal(found.slot, { x: found.local.x, y: found.local.y, slice });
    },
    hideForCapture() {
      capturing = true;
      for (const slot of slots.values()) {
        slot.wheel = null;
        slot.marker = null;
        if (slot.ready && !slot.win.isDestroyed()) {
          slot.win.webContents.send(IPC.SCREEN_PING_WHEEL, { show: false, x: 0, y: 0, slice: null });
          slot.win.webContents.send(IPC.SCREEN_PING_MARKER, {
            show: false, x: 0, y: 0, phase: 'loading', text: '', cropW: 0, cropH: 0, frame: false,
          });
        }
        if (!slot.win.isDestroyed() && slot.win.isVisible()) slot.win.hide();
      }
    },
    reveal() {
      capturing = false;
      for (const slot of slots.values()) {
        showPinned(slot);
        flushSignals(slot);
      }
    },
    destroy() {
      capturing = false;
      unbindDisplayListener();
      destroyWindows();
    },
  };
}
