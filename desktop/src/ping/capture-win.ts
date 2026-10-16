/**
 * 裁一块屏幕到 PNG。调用前要先藏起问号浮层，否则会把自己拍进去。
 */
import { nativeImage } from 'electron';
import koffi from 'koffi';
import { cropAroundPoint, type CropRect } from './geometry';

const SRCCOPY = 0x00cc0020;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;

interface CaptureApi {
  getSystemMetrics(index: number): number;
  getDC(hwnd: null): unknown;
  releaseDC(hwnd: null, hdc: unknown): number;
  createCompatibleDC(hdc: unknown): unknown;
  createCompatibleBitmap(hdc: unknown, w: number, h: number): unknown;
  selectObject(hdc: unknown, obj: unknown): unknown;
  bitBlt(dst: unknown, x: number, y: number, w: number, h: number, src: unknown, sx: number, sy: number, rop: number): number;
  deleteObject(obj: unknown): number;
  deleteDC(hdc: unknown): number;
  getDIBits(hdc: unknown, bmp: unknown, start: number, lines: number, bits: Buffer, bmi: Buffer, usage: number): number;
  getLastError(): number;
}

let api: CaptureApi | null = null;

function native(): CaptureApi {
  if (api) return api;
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const fn = (lib: ReturnType<typeof koffi.load>, signature: string) => lib.func(signature);
  api = {
    getSystemMetrics: fn(user32, 'int __stdcall GetSystemMetrics(int nIndex)') as CaptureApi['getSystemMetrics'],
    getDC: fn(user32, 'void * __stdcall GetDC(void *hwnd)') as CaptureApi['getDC'],
    releaseDC: fn(user32, 'int __stdcall ReleaseDC(void *hwnd, void *hdc)') as CaptureApi['releaseDC'],
    createCompatibleDC: fn(gdi32, 'void * __stdcall CreateCompatibleDC(void *hdc)') as CaptureApi['createCompatibleDC'],
    createCompatibleBitmap: fn(gdi32, 'void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)') as CaptureApi['createCompatibleBitmap'],
    selectObject: fn(gdi32, 'void * __stdcall SelectObject(void *hdc, void *obj)') as CaptureApi['selectObject'],
    bitBlt: fn(gdi32, 'int __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)') as CaptureApi['bitBlt'],
    deleteObject: fn(gdi32, 'int __stdcall DeleteObject(void *obj)') as CaptureApi['deleteObject'],
    deleteDC: fn(gdi32, 'int __stdcall DeleteDC(void *hdc)') as CaptureApi['deleteDC'],
    getDIBits: fn(gdi32, 'int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, void *bits, void *bmi, uint32 usage)') as CaptureApi['getDIBits'],
    getLastError: fn(kernel32, 'uint32 __stdcall GetLastError()') as CaptureApi['getLastError'],
  };
  return api;
}

function virtualScreen(win: CaptureApi): { left: number; top: number; width: number; height: number } {
  const width = win.getSystemMetrics(SM_CXVIRTUALSCREEN);
  const height = win.getSystemMetrics(SM_CYVIRTUALSCREEN);
  if (width > 0 && height > 0) {
    return {
      left: win.getSystemMetrics(SM_XVIRTUALSCREEN),
      top: win.getSystemMetrics(SM_YVIRTUALSCREEN),
      width,
      height,
    };
  }
  return {
    left: 0,
    top: 0,
    width: win.getSystemMetrics(SM_CXSCREEN),
    height: win.getSystemMetrics(SM_CYSCREEN),
  };
}

function flipBottomUp(width: number, height: number, pixels: Buffer): Buffer {
  const stride = width * 4;
  const out = Buffer.alloc(pixels.length);
  for (let y = 0; y < height; y++) {
    pixels.copy(out, y * stride, (height - 1 - y) * stride, (height - y) * stride);
  }
  return out;
}

export interface RegionShot {
  dataUrl: string;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
}

/** 以物理像素落点为中心截一块，返回 PNG data URL。 */
export function captureRegionAround(pointX: number, pointY: number, size?: number): RegionShot {
  if (process.platform !== 'win32') {
    throw new Error('屏幕问号截图只在 Windows 上可用');
  }
  const win = native();
  const screen = virtualScreen(win);
  const crop: CropRect = cropAroundPoint(pointX, pointY, screen, size);
  const hdc = win.getDC(null);
  if (!hdc) throw new Error(`GetDC failed (${win.getLastError()})`);
  let memory: unknown = null;
  let bitmap: unknown = null;
  try {
    memory = win.createCompatibleDC(hdc);
    bitmap = win.createCompatibleBitmap(hdc, crop.width, crop.height);
    if (!memory || !bitmap) throw new Error(`Could not create a screen bitmap (${win.getLastError()})`);
    const previous = win.selectObject(memory, bitmap);
    const copied = win.bitBlt(memory, 0, 0, crop.width, crop.height, hdc, crop.x, crop.y, SRCCOPY);
    if (previous) win.selectObject(memory, previous);
    if (!copied) throw new Error(`BitBlt failed (${win.getLastError()})`);

    const bmi = Buffer.alloc(40);
    bmi.writeUInt32LE(40, 0);
    bmi.writeInt32LE(crop.width, 4);
    bmi.writeInt32LE(crop.height, 8);
    bmi.writeUInt16LE(1, 12);
    bmi.writeUInt16LE(32, 14);
    const stride = crop.width * 4;
    bmi.writeUInt32LE(stride * crop.height, 20);
    const pixels = Buffer.alloc(stride * crop.height);
    const rows = win.getDIBits(memory, bitmap, 0, crop.height, pixels, bmi, 0);
    if (rows !== crop.height) throw new Error(`GetDIBits returned ${rows} rows, expected ${crop.height}`);

    const image = nativeImage.createFromBitmap(flipBottomUp(crop.width, crop.height, pixels), {
      width: crop.width,
      height: crop.height,
    });
    const png = image.toPNG();
    return {
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      anchorX: crop.anchorX,
      anchorY: crop.anchorY,
      width: crop.width,
      height: crop.height,
    };
  } finally {
    if (bitmap) win.deleteObject(bitmap);
    if (memory) win.deleteDC(memory);
    win.releaseDC(null, hdc);
  }
}
