/**
 * 每块屏幕一个透明、置顶、点击穿透的浮层，用来画轮盘和问号。
 * 窗口比屏幕少 1 像素，避免资源管理器把它当成全屏程序藏起任务栏。
 */
import path from 'node:path';
import { BrowserWindow, ipcMain, screen, type Display, type IpcMainEvent, type Rectangle } from 'electron';
import { IPC } from '../constants';
import { cropCssSize, physicalToLocal, type DisplayMap, type ScreenRect } from './geometry';
import { askAnchorNear, physicalRectToLocal, snipBarPlacement, snipChromeDisplay } from './snip-session';

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

interface SnipShow {
  show: boolean;
  scale: number;
  rect?: { x: number; y: number; w: number; h: number } | null;
  chosen?: boolean;
  /** 本屏要不要画完成按钮。跨屏时只有选区右下角所在的那块屏幕为 true。 */
  bar?: { x: number; y: number } | null;
  label?: string;
  /** copy 复制进输入框，ask 交给模型。 */
  purpose?: 'copy' | 'ask';
}

interface SnipHandlers {
  onOk: () => void;
  onCancel: () => void;
}

interface OverlaySlot {
  displayId: number;
  win: BrowserWindow;
  ready: boolean;
  wheel: WheelView | null;
  marker: MarkerView | null;
  pendingSignals: SignalView[];
  pendingSnip: SnipShow | null;
  /** 这块屏幕上的选区，坐标相对浮层，可以伸出屏幕。 */
  askRegion: { x: number; y: number; w: number; h: number } | null;
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
  /** 在框选区域下沿旁显示问号和回答，并描出这块区域。 */
  showAsk(rect: ScreenRect, phase: MarkerView['phase'], text: string): void;
  hideMarker(): void;
  /** 轮盘上的普通标记。问号和框选不走这里。 */
  showSignal(originX: number, originY: number, slice: number): void;
  /** 左右松手后铺满每块屏幕，让用户自己拖出截图区域。 */
  beginSnip(handlers: SnipHandlers, purpose: 'copy' | 'ask'): void;
  /** 把同一块物理矩形画到每一块屏幕上。坐标可以伸出本屏。 */
  paintSnip(rect: ScreenRect | null, chosen: boolean): void;
  endSnip(): void;
  reveal(): void;
  destroy(): void;
}

/**
 * 屏幕上仍画着问号和矩形，BitBlt 看不到这个窗口。
 * 窗口一旦盖住整屏，这次设置会被系统拒绝，所以要在铺开之前调用。
 */
function excludeFromCapture(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  win.setContentProtection(true);
}

function readSnipResult(payload: unknown): { action: 'cancel' } | { action: 'ok' } | null {
  if (!payload || typeof payload !== 'object') return null;
  const action = (payload as { action?: unknown }).action;
  if (action === 'cancel') return { action: 'cancel' };
  if (action === 'ok') return { action: 'ok' };
  return null;
}

/** 钩子和框选会话要用同一套屏幕映射。 */
export function readPingDisplayMaps(): DisplayMap[] {
  return currentMaps();
}

export function createPingOverlay(onDisplaysChanged: () => void): PingOverlay {
  const slots = new Map<number, OverlaySlot>();
  let listenerBound = false;
  let refreshing = false;
  let snipHandlers: SnipHandlers | null = null;
  let snipPurpose: 'copy' | 'ask' = 'copy';
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
      width: Math.min(200, bounds.width),
      height: Math.min(200, bounds.height),
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
    excludeFromCapture(win);
    win.setBounds(bounds);
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
      pendingSnip: null,
      askRegion: null,
    };
    // 混合缩放时第一帧的窗口位置会偏，标记就会跟着往右下挪。准备好后再钉一次。
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      win.setBounds(overlayBounds(display));
      excludeFromCapture(win);
    });
    win.webContents.on('did-finish-load', () => {
      slot.ready = true;
      push(slot);
      flushSignals(slot);
      if (slot.pendingSnip) slot.win.webContents.send(IPC.SCREEN_PING_SNIP, slot.pendingSnip);
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
   * 无边框窗口藏起来再显示，系统会把它往右下抬。
   * 这里在显示之前把原点设好，显示之后不再改。
   */
  function showPinned(slot: OverlaySlot): void {
    if (slot.win.isDestroyed() || slot.win.isVisible()) return;
    const display = screen.getAllDisplays().find((item) => item.id === slot.displayId);
    if (display) slot.win.setBounds(overlayBounds(display));
    excludeFromCapture(slot.win);
    if (typeof slot.win.showInactive === 'function') slot.win.showInactive();
    else slot.win.show();
  }

  function emitSignal(slot: OverlaySlot, payload: SignalView): void {
    if (!slot.ready || slot.win.isDestroyed()) {
      slot.pendingSignals.push(payload);
      return;
    }
    slot.win.webContents.send(IPC.SCREEN_PING_SIGNAL, payload);
  }

  function flushSignals(slot: OverlaySlot): void {
    if (!slot.ready || slot.win.isDestroyed()) return;
    const queued = slot.pendingSignals.splice(0);
    for (const payload of queued) slot.win.webContents.send(IPC.SCREEN_PING_SIGNAL, payload);
  }

  function push(slot: OverlaySlot): void {
    if (!slot.ready || slot.win.isDestroyed()) return;
    slot.win.webContents.send(IPC.SCREEN_PING_WHEEL, slot.wheel ?? { show: false, x: 0, y: 0, slice: null });
    const marker = slot.marker ?? {
      show: false, x: 0, y: 0, phase: 'loading' as const, text: '', cropW: 0, cropH: 0, frame: false,
    };
    slot.win.webContents.send(IPC.SCREEN_PING_MARKER, { ...marker, region: slot.askRegion });
  }

  function revealSlot(slot: OverlaySlot): void {
    if (slot.win.isDestroyed()) return;
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
    for (const slot of slots.values()) {
      slot.marker = null;
      slot.askRegion = null;
    }
  }

  function destroyWindows(): void {
    for (const slot of slots.values()) {
      if (!slot.win.isDestroyed()) slot.win.destroy();
    }
    slots.clear();
  }

  function sendSnip(slot: OverlaySlot, payload: SnipShow): void {
    slot.pendingSnip = payload.show ? payload : null;
    if (!slot.ready || slot.win.isDestroyed()) return;
    slot.win.webContents.send(IPC.SCREEN_PING_SNIP, payload);
  }

  function armSnipInput(slot: OverlaySlot): void {
    if (slot.win.isDestroyed()) return;
    showPinned(slot);
    slot.win.setAlwaysOnTop(true, 'screen-saver');
    slot.win.setFocusable(true);
    slot.win.setIgnoreMouseEvents(false);
  }

  function disarmSnipInput(slot: OverlaySlot): void {
    if (slot.win.isDestroyed()) return;
    try { slot.win.blur(); } catch { /* 没有焦点 */ }
    slot.win.setIgnoreMouseEvents(true, { forward: true });
    try { slot.win.setFocusable(false); } catch { /* 窗口正在销毁时系统会拒绝 */ }
  }

  function hideSnipUi(): void {
    for (const slot of slots.values()) {
      sendSnip(slot, { show: false, scale: 1 });
      disarmSnipInput(slot);
    }
  }

  function focusCursorSlot(): void {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const slot = slots.get(display.id);
    if (!slot || slot.win.isDestroyed()) return;
    try { slot.win.focus(); } catch { /* 没焦点时仍可以拖，Esc 由钩子收 */ }
  }

  function onSnipResult(_event: IpcMainEvent, payload: unknown): void {
    const handlers = snipHandlers;
    if (!handlers) return;
    const parsed = readSnipResult(payload);
    if (!parsed) return;
    snipHandlers = null;
    hideSnipUi();
    if (parsed.action === 'cancel') handlers.onCancel();
    else handlers.onOk();
  }

  ipcMain.on(IPC.SCREEN_PING_SNIP_RESULT, onSnipResult);

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
    showAsk(rect, phase, text) {
      const maps = currentMaps();
      const anchor = askAnchorNear(rect, maps);
      const hit = physicalToLocal(anchor.x, anchor.y, maps);
      for (const slot of slots.values()) {
        const map = maps.find((item) => item.id === slot.displayId);
        slot.askRegion = map ? physicalRectToLocal(rect, map) : null;
        slot.marker = hit && hit.id === slot.displayId
          ? { show: true, x: hit.x, y: hit.y, phase, text, cropW: 0, cropH: 0, frame: false }
          : null;
        showPinned(slot);
        push(slot);
      }
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
        if (!slot.marker?.show || !slot.ready || slot.win.isDestroyed()) continue;
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
        if (!slot.ready || slot.win.isDestroyed()) continue;
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
    beginSnip(handlers, purpose) {
      snipHandlers = handlers;
      snipPurpose = purpose === 'ask' ? 'ask' : 'copy';
      for (const slot of slots.values()) armSnipInput(slot);
      this.paintSnip(null, false);
      focusCursorSlot();
    },
    paintSnip(rect, chosen) {
      if (!snipHandlers) return;
      const maps = currentMaps();
      const owner = rect && chosen ? snipChromeDisplay(rect, maps) : null;
      const label = rect ? `${Math.round(rect.width)} × ${Math.round(rect.height)}` : '';
      for (const slot of slots.values()) {
        const map = maps.find((item) => item.id === slot.displayId);
        const scale = map && map.scale > 0 ? map.scale : 1;
        const local = rect && map ? physicalRectToLocal(rect, map) : null;
        const bar = local && owner === slot.displayId && map
          ? snipBarPlacement(local, { width: map.dip.width, height: map.dip.height })
          : null;
        sendSnip(slot, {
          show: true,
          scale,
          rect: local,
          chosen,
          bar,
          label,
          purpose: snipPurpose,
        });
      }
    },
    endSnip() {
      snipHandlers = null;
      hideSnipUi();
    },
    reveal() {
      for (const slot of slots.values()) {
        showPinned(slot);
        flushSignals(slot);
      }
    },
    destroy() {
      ipcMain.removeListener(IPC.SCREEN_PING_SNIP_RESULT, onSnipResult);
      snipHandlers = null;
      unbindDisplayListener();
      destroyWindows();
    },
  };
}
