/**
 * 轮盘正下方弹出的待办草稿。单独一个小窗，因为问号浮层点透、也不能获得焦点。
 * 输入条的中心对准从前插蓝旗的落点，也就是拖动起点。
 */
import path from 'node:path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import koffi from 'koffi';
import { IPC } from '../constants';

export interface TodoDraftState {
  dipX: number;
  dipY: number;
  text: string;
  image: string | null;
  error: string;
}

export interface TodoDraft {
  show(state: TodoDraftState): void;
  hide(): void;
  destroy(): void;
}

const WIDTH = 300;
const BAR_H = 36;
const ERROR_H = 18;

function readText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const text = (payload as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function windowHeight(error: string): number {
  return BAR_H + (error ? ERROR_H : 0);
}

let handlers: {
  onSubmit: (text: string) => void;
  onSnip: (text: string) => void;
  onCancel: () => void;
} | null = null;
let ipcBound = false;

function bindIpc(): void {
  if (ipcBound) return;
  ipcBound = true;
  ipcMain.on(IPC.TODO_DRAFT_SUBMIT, (_event, payload: unknown) => {
    handlers?.onSubmit(readText(payload));
  });
  ipcMain.on(IPC.TODO_DRAFT_SNIP, (_event, payload: unknown) => {
    handlers?.onSnip(readText(payload));
  });
  ipcMain.on(IPC.TODO_DRAFT_CANCEL, () => {
    handlers?.onCancel();
  });
}

interface FocusNative {
  setForeground(hwnd: bigint): number;
  getForeground(): bigint | number;
  threadOf(hwnd: bigint, pid: number): number;
  attach(from: number, to: number, on: number): number;
  currentThread(): number;
  bringToTop(hwnd: bigint): number;
}

let focusNative: FocusNative | null = null;

function loadFocusNative(): FocusNative {
  if (focusNative) return focusNative;
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  focusNative = {
    setForeground: user32.func('int __stdcall SetForegroundWindow(intptr_t hWnd)') as FocusNative['setForeground'],
    getForeground: user32.func('intptr_t __stdcall GetForegroundWindow()') as FocusNative['getForeground'],
    threadOf: user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, intptr_t pid)') as FocusNative['threadOf'],
    attach: user32.func('int __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)') as FocusNative['attach'],
    currentThread: kernel32.func('uint32 __stdcall GetCurrentThreadId()') as FocusNative['currentThread'],
    bringToTop: user32.func('int __stdcall BringWindowToTop(intptr_t hWnd)') as FocusNative['bringToTop'],
  };
  return focusNative;
}

function hwndOf(win: BrowserWindow): bigint {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? buf.readBigInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function asHwnd(value: bigint | number | null | undefined): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(value);
  return 0n;
}

/** 页面里的 input.focus() 只点亮光标。Windows 没把前台交给这个窗时，按键仍进别的程序。 */
function takeForeground(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.setFocusable(true);
  win.show();
  win.moveTop();
  if (process.platform === 'win32') {
    try {
      const api = loadFocusNative();
      const hwnd = hwndOf(win);
      const fg = asHwnd(api.getForeground());
      const fgThread = fg ? api.threadOf(fg, 0) : 0;
      const cur = api.currentThread();
      const attached = Boolean(fgThread && fgThread !== cur && api.attach(cur, fgThread, 1));
      api.bringToTop(hwnd);
      api.setForeground(hwnd);
      if (attached) api.attach(cur, fgThread, 0);
    } catch { /* 下面的 focus 再试一次 */ }
  }
  win.focus();
  if (!win.webContents.isDestroyed()) win.webContents.focus();
}

function place(win: BrowserWindow, dipX: number, dipY: number, height: number): void {
  const display = screen.getDisplayNearestPoint({ x: Math.round(dipX), y: Math.round(dipY) });
  const area = display.workArea;
  let x = Math.round(dipX - WIDTH / 2);
  let y = Math.round(dipY - BAR_H / 2);
  if (x < area.x) x = area.x;
  if (y < area.y) y = area.y;
  if (x + WIDTH > area.x + area.width) x = area.x + area.width - WIDTH;
  if (y + height > area.y + area.height) y = area.y + area.height - height;
  win.setBounds({ x, y, width: WIDTH, height });
}

export function createTodoDraft(next: {
  onSubmit: (text: string) => void;
  onSnip: (text: string) => void;
  onCancel: () => void;
}): TodoDraft {
  bindIpc();
  handlers = next;
  let win: BrowserWindow | null = null;
  let pending: TodoDraftState | null = null;
  let acceptBlur = false;
  let blurGen = 0;
  let destroyed = false;

  /** 刚弹出时前台还在别的窗口上，晚一点才把失焦当成取消。 */
  function armBlur(): void {
    const gen = blurGen;
    setTimeout(() => {
      if (destroyed || gen !== blurGen) return;
      acceptBlur = true;
    }, 280);
  }

  function pushState(view: BrowserWindow): void {
    if (!pending || view.isDestroyed() || view.webContents.isDestroyed()) return;
    view.webContents.send(IPC.TODO_DRAFT_STATE, {
      text: pending.text,
      image: pending.image,
      error: pending.error,
    });
  }

  function ensure(): BrowserWindow {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      width: WIDTH,
      height: BAR_H,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      show: false,
      backgroundColor: '#1c1f22',
      roundedCorners: true,
      ...(process.platform === 'win32' ? { thickFrame: false } : {}),
      webPreferences: {
        preload: path.join(__dirname, '..', 'ping-todo-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    if (process.platform === 'win32') win.setContentProtection(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.on('blur', () => {
      if (!acceptBlur) return;
      const gen = blurGen;
      setTimeout(() => {
        if (gen !== blurGen || !acceptBlur || !win || win.isDestroyed()) return;
        if (!win.isVisible() || win.isFocused()) return;
        handlers?.onCancel();
      }, 180);
    });
    win.on('close', (event) => {
      if (destroyed) return;
      event.preventDefault();
      handlers?.onCancel();
    });
    win.webContents.on('did-finish-load', () => {
      if (!win || win.isDestroyed() || !pending) return;
      takeForeground(win);
      pushState(win);
      armBlur();
    });
    void win.loadFile(path.join(__dirname, '..', '..', 'assets', 'todo-draft.html'));
    return win;
  }

  return {
    show(state) {
      if (destroyed) return;
      pending = state;
      blurGen += 1;
      acceptBlur = false;
      const view = ensure();
      place(view, state.dipX, state.dipY, windowHeight(state.error));
      view.setAlwaysOnTop(true, 'screen-saver');
      takeForeground(view);
      if (view.webContents.isLoading()) return;
      pushState(view);
      armBlur();
    },
    hide() {
      blurGen += 1;
      acceptBlur = false;
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
    },
    destroy() {
      destroyed = true;
      handlers = null;
      blurGen += 1;
      acceptBlur = false;
      if (win && !win.isDestroyed()) {
        win.removeAllListeners('close');
        win.destroy();
      }
      win = null;
    },
  };
}
