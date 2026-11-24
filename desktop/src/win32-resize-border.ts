/**
 * 把无边框窗口的内侧缩放热区收成系统细边（SM_CXEDGE，通常 2px）。
 * 滚动条因此落在客户区里，拖滑块不再被当成拉窗口。窗口最外缘仍可缩放。
 */
import koffi from 'koffi';
import { narrowResizeHit, ncHitPoint, type WindowRect } from './window-resize-hit';

const WM_NCHITTEST = 0x0084;
const WM_NCDESTROY = 0x0082;
const SM_CXEDGE = 45;
const SUBCLASS_ID = 0x1ce0;

interface NativeBorder {
  setSubclass(hwnd: bigint, proc: unknown, id: bigint, refData: bigint): number;
  removeSubclass(hwnd: bigint, proc: unknown, id: bigint): number;
  defSubclass(hwnd: bigint, msg: number, wParam: bigint, lParam: bigint): bigint;
  getWindowRect(hwnd: bigint, rect: Buffer): number;
  getSystemMetrics(index: number): number;
  procType: unknown;
}

let native: NativeBorder | null = null;
const installed = new Set<string>();
const callbacks = new Set<unknown>();

function loadNative(): NativeBorder {
  if (native) return native;
  const user32 = koffi.load('user32.dll');
  const comctl32 = koffi.load('comctl32.dll');
  const proc = koffi.proto(
    'intptr_t __stdcall IceResizeSubclass(uintptr_t hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam, uintptr_t id, uintptr_t refData)',
  );
  native = {
    setSubclass: comctl32.func('int __stdcall SetWindowSubclass(uintptr_t hWnd, intptr_t pfnSubclass, uintptr_t uIdSubclass, uintptr_t dwRefData)'),
    removeSubclass: comctl32.func('int __stdcall RemoveWindowSubclass(uintptr_t hWnd, intptr_t pfnSubclass, uintptr_t uIdSubclass)'),
    defSubclass: comctl32.func('intptr_t __stdcall DefSubclassProc(uintptr_t hWnd, uint32_t uMsg, uintptr_t wParam, intptr_t lParam)'),
    getWindowRect: user32.func('int __stdcall GetWindowRect(uintptr_t hWnd, _Out_ uint8_t *rect)'),
    getSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)'),
    procType: koffi.pointer(proc),
  };
  return native;
}

function asBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  return 0n;
}

function readRect(buf: Buffer): WindowRect {
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12),
  };
}

export function hwndFromNativeHandle(handle: Buffer): bigint {
  if (handle.length >= 8) return handle.readBigUInt64LE(0);
  return BigInt(handle.readUInt32LE(0));
}

/** 只在 Windows 主窗口上安装。失败时保留 Electron 原来的热区，不挡住启动。 */
export function installThinWindowResizeBorder(win: { getNativeWindowHandle(): Buffer }): void {
  if (process.platform !== 'win32') return;
  let api: NativeBorder;
  try {
    api = loadNative();
  } catch (err) {
    console.warn('[window] 缩放热区收窄未装上:', err instanceof Error ? err.message : err);
    return;
  }
  const hwnd = hwndFromNativeHandle(win.getNativeWindowHandle());
  const key = hwnd.toString();
  if (installed.has(key)) return;

  const edge = Math.max(1, api.getSystemMetrics(SM_CXEDGE) || 1);
  const proc = koffi.register((
    windowHandle: bigint,
    msg: number,
    wParam: bigint,
    lParam: bigint,
    id: bigint,
    _ref: bigint,
  ) => {
    if (msg === WM_NCDESTROY) {
      try { api.removeSubclass(windowHandle, proc, id); } catch { /* 窗口正在销毁 */ }
      installed.delete(key);
    }
    const result = api.defSubclass(windowHandle, msg, asBigInt(wParam), asBigInt(lParam));
    if (msg !== WM_NCHITTEST) return result;
    try {
      const rectBuf = Buffer.alloc(16);
      if (!api.getWindowRect(windowHandle, rectBuf)) return result;
      const point = ncHitPoint(lParam);
      return BigInt(narrowResizeHit(Number(result), point.x, point.y, readRect(rectBuf), edge));
    } catch {
      return result;
    }
  }, api.procType as never);

  callbacks.add(proc);
  const ok = api.setSubclass(hwnd, proc, BigInt(SUBCLASS_ID), 0n);
  if (!ok) {
    console.warn('[window] SetWindowSubclass 失败，滚动条仍可能压在缩放热区上');
    return;
  }
  installed.add(key);
}
