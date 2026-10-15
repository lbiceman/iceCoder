/**
 * 通过 user32.SendInput / GDI 向当前 Windows 桌面注入真实键鼠，并截取主屏幕。
 * 只在工具真正执行时加载。坐标与截图像素同一套：主屏幕左上角为 (0, 0)。
 */

import koffi from 'koffi';
import { resolveKeyToken, type MouseButton } from './windows-actions.js';

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const SRCCOPY = 0x00CC0020;
const WHEEL_DELTA = 120;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
const VK_RETURN = 0x0D;
const VK_TAB = 0x09;

const BUTTON_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP },
  right: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP },
  middle: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP },
};

type NativeFn = (...args: any[]) => any;

interface NativeApi {
  getCursorPos(point: Buffer): number;
  setCursorPos(x: number, y: number): number;
  getSystemMetrics(index: number): number;
  sendInput(count: number, inputs: unknown[], cbSize: number): number;
  inputSize: number;
  getLastError(): number;
  vkKeyScanW(ch: number): number;
  getDC(hwnd: null): unknown;
  releaseDC(hwnd: null, hdc: unknown): number;
  createCompatibleDC(hdc: unknown): unknown;
  createCompatibleBitmap(hdc: unknown, w: number, h: number): unknown;
  selectObject(hdc: unknown, obj: unknown): unknown;
  bitBlt(dst: unknown, x: number, y: number, w: number, h: number, src: unknown, sx: number, sy: number, rop: number): number;
  deleteObject(obj: unknown): number;
  deleteDC(hdc: unknown): number;
  getDIBits(hdc: unknown, bmp: unknown, start: number, lines: number, bits: Buffer, bmi: Buffer, usage: number): number;
}

let cached: Win32Desktop | null = null;

export interface ScreenCapture {
  width: number;
  height: number;
  /** 自下而上的 32 位 BGRA，与 BMP 像素区一致。 */
  pixels: Buffer;
  cursorX: number;
  cursorY: number;
  /** 图像 (0, 0) 对应的屏幕坐标。多屏时可能为负数。 */
  originX: number;
  originY: number;
  /** false 表示虚拟桌面太大，只截了主屏幕。 */
  fullDesktop: boolean;
}

export interface Win32Desktop {
  cursor(): { x: number; y: number };
  primarySize(): { width: number; height: number };
  /** 相对移动 0。若光标被带跑，用 SetCursorPos 放回去。 */
  pointerNudgeZero(): { sent: number; moved: boolean };
  move(x: number, y: number): void;
  click(x: number, y: number, button: MouseButton, clicks: number, signal?: AbortSignal): Promise<void>;
  drag(x: number, y: number, toX: number, toY: number, button: MouseButton, signal?: AbortSignal): Promise<void>;
  scroll(x: number | null, y: number | null, notches: number): void;
  typeText(text: string): void;
  pressTokens(tokens: string[]): void;
  capturePrimary(): ScreenCapture;
}

export function getWin32Desktop(): Win32Desktop {
  if (process.platform !== 'win32') {
    throw new Error('Windows desktop control is only available on Windows.');
  }
  if (!cached) cached = createDesktop(loadNative());
  return cached;
}

function defineInputType() {
  const mouse = koffi.struct('MOUSEINPUT', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'int32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const key = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const hardware = koffi.struct('HARDWAREINPUT', {
    uMsg: 'uint32',
    wParamL: 'uint16',
    wParamH: 'uint16',
  });
  return koffi.struct('INPUT', {
    type: 'uint32',
    u: koffi.union({ mi: mouse, ki: key, hi: hardware }),
  });
}

interface DesktopInput {
  type: number;
  u: {
    mi?: { dx: number; dy: number; mouseData: number; dwFlags: number; time: number; dwExtraInfo: number };
    ki?: { wVk: number; wScan: number; dwFlags: number; time: number; dwExtraInfo: number };
  };
}

function loadNative(): NativeApi {
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const fn = (lib: ReturnType<typeof koffi.load>, signature: string): NativeFn => lib.func(signature);
  const inputType = defineInputType();
  return {
    getCursorPos: fn(user32, 'int __stdcall GetCursorPos(_Out_ uint8_t *point)'),
    setCursorPos: fn(user32, 'int __stdcall SetCursorPos(int x, int y)'),
    getSystemMetrics: fn(user32, 'int __stdcall GetSystemMetrics(int nIndex)'),
    sendInput: fn(user32, 'uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)'),
    inputSize: koffi.sizeof(inputType),
    getLastError: fn(kernel32, 'uint32 __stdcall GetLastError()'),
    vkKeyScanW: fn(user32, 'int16 __stdcall VkKeyScanW(uint16 ch)'),
    getDC: fn(user32, 'void * __stdcall GetDC(void *hwnd)'),
    releaseDC: fn(user32, 'int __stdcall ReleaseDC(void *hwnd, void *hdc)'),
    createCompatibleDC: fn(gdi32, 'void * __stdcall CreateCompatibleDC(void *hdc)'),
    createCompatibleBitmap: fn(gdi32, 'void * __stdcall CreateCompatibleBitmap(void *hdc, int cx, int cy)'),
    selectObject: fn(gdi32, 'void * __stdcall SelectObject(void *hdc, void *obj)'),
    bitBlt: fn(gdi32, 'int __stdcall BitBlt(void *hdc, int x, int y, int cx, int cy, void *hdcSrc, int x1, int y1, uint32 rop)'),
    deleteObject: fn(gdi32, 'int __stdcall DeleteObject(void *obj)'),
    deleteDC: fn(gdi32, 'int __stdcall DeleteDC(void *hdc)'),
    getDIBits: fn(gdi32, 'int __stdcall GetDIBits(void *hdc, void *hbm, uint32 start, uint32 lines, void *bits, void *bmi, uint32 usage)'),
  };
}

function createDesktop(api: NativeApi): Win32Desktop {
  function cursor(): { x: number; y: number } {
    const point = Buffer.alloc(8);
    if (!api.getCursorPos(point)) {
      throw new Error(`GetCursorPos failed (${api.getLastError()})`);
    }
    return { x: point.readInt32LE(0), y: point.readInt32LE(4) };
  }

  function primarySize(): { width: number; height: number } {
    const width = api.getSystemMetrics(SM_CXSCREEN);
    const height = api.getSystemMetrics(SM_CYSCREEN);
    if (width <= 0 || height <= 0) {
      throw new Error(`Primary screen size is ${width}x${height}`);
    }
    return { width, height };
  }

  function virtualMetrics(): { left: number; top: number; width: number; height: number } {
    const width = api.getSystemMetrics(SM_CXVIRTUALSCREEN);
    const height = api.getSystemMetrics(SM_CYVIRTUALSCREEN);
    if (width <= 0 || height <= 0) {
      const primary = primarySize();
      return { left: 0, top: 0, width: primary.width, height: primary.height };
    }
    return {
      left: api.getSystemMetrics(SM_XVIRTUALSCREEN),
      top: api.getSystemMetrics(SM_YVIRTUALSCREEN),
      width,
      height,
    };
  }

  function mouseInput(dx: number, dy: number, mouseData: number, flags: number): DesktopInput {
    return {
      type: INPUT_MOUSE,
      u: { mi: { dx, dy, mouseData, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
  }

  function keyInput(vk: number, scan: number, flags: number): DesktopInput {
    return {
      type: INPUT_KEYBOARD,
      u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    };
  }

  function sendInputs(events: DesktopInput[]): void {
    if (events.length === 0) return;
    const sent = api.sendInput(events.length, events, api.inputSize);
    if (sent !== events.length) {
      throw new Error(`SendInput delivered ${sent} of ${events.length} events (GetLastError=${api.getLastError()})`);
    }
  }

  function absolutePoint(x: number, y: number): { ax: number; ay: number } {
    const screen = virtualMetrics();
    const ax = Math.round(((x - screen.left) * 65535) / screen.width);
    const ay = Math.round(((y - screen.top) * 65535) / screen.height);
    return {
      ax: Math.min(65535, Math.max(0, ax)),
      ay: Math.min(65535, Math.max(0, ay)),
    };
  }

  function absoluteMove(x: number, y: number, extraFlags = 0, mouseData = 0): DesktopInput {
    const { ax, ay } = absolutePoint(x, y);
    return mouseInput(
      ax,
      ay,
      mouseData,
      MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | extraFlags,
    );
  }

  function move(x: number, y: number): void {
    sendInputs([absoluteMove(x, y)]);
  }

  function scanChar(ch: string, applyModifiers: boolean): number[] {
    const code = ch.charCodeAt(0);
    const scanned = api.vkKeyScanW(code);
    if (scanned === -1 || (scanned & 0xff) === 0xff) {
      throw new Error(`Cannot type key "${ch}" as a virtual key. Use action "type" for characters.`);
    }
    const vk = scanned & 0xff;
    if (!applyModifiers) return [vk];
    const shiftState = (scanned >> 8) & 0xff;
    const mods: number[] = [];
    if (shiftState & 1) mods.push(VK_SHIFT);
    if (shiftState & 2) mods.push(VK_CONTROL);
    if (shiftState & 4) mods.push(VK_MENU);
    return [...mods, vk];
  }

  function expandTokens(tokens: string[]): number[] {
    const sole = tokens.length === 1;
    const vks: number[] = [];
    for (const token of tokens) {
      const resolved = resolveKeyToken(token);
      if (!resolved.ok) throw new Error(resolved.error);
      if ('vk' in resolved) {
        vks.push(resolved.vk);
      } else {
        vks.push(...scanChar(resolved.scanChar, sole));
      }
    }
    return vks;
  }

  function unicodeInputs(text: string): DesktopInput[] {
    const events: DesktopInput[] = [];
    for (const ch of text) {
      if (ch === '\r') continue;
      if (ch === '\n') {
        events.push(keyInput(VK_RETURN, 0, 0), keyInput(VK_RETURN, 0, KEYEVENTF_KEYUP));
        continue;
      }
      if (ch === '\t') {
        events.push(keyInput(VK_TAB, 0, 0), keyInput(VK_TAB, 0, KEYEVENTF_KEYUP));
        continue;
      }
      const code = ch.codePointAt(0) ?? 0;
      const units = code > 0xffff
        ? [0xD800 + ((code - 0x10000) >> 10), 0xDC00 + ((code - 0x10000) & 0x3ff)]
        : [code];
      for (const unit of units) {
        events.push(
          keyInput(0, unit, KEYEVENTF_UNICODE),
          keyInput(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
        );
      }
    }
    return events;
  }

  return {
    cursor,
    primarySize,
    pointerNudgeZero() {
      const before = cursor();
      sendInputs([mouseInput(0, 0, 0, MOUSEEVENTF_MOVE)]);
      const after = cursor();
      const moved = Math.abs(after.x - before.x) > 2 || Math.abs(after.y - before.y) > 2;
      if (moved) api.setCursorPos(before.x, before.y);
      return { sent: 1, moved };
    },
    move,
    async click(x, y, button, clicks, signal) {
      const flags = BUTTON_FLAGS[button];
      for (let i = 0; i < clicks; i++) {
        throwIfAborted(signal);
        sendInputs([
          absoluteMove(x, y, flags.down),
          absoluteMove(x, y, flags.up),
        ]);
        if (i + 1 < clicks) await delay(50, signal);
      }
    },
    async drag(x, y, toX, toY, button, signal) {
      const flags = BUTTON_FLAGS[button];
      const steps = dragSteps(x, y, toX, toY);
      let held = false;
      try {
        throwIfAborted(signal);
        sendInputs([absoluteMove(x, y, flags.down)]);
        held = true;
        await delay(16, signal);
        const moves: DesktopInput[] = [];
        for (let i = 1; i <= steps; i++) {
          const px = Math.round(x + ((toX - x) * i) / steps);
          const py = Math.round(y + ((toY - y) * i) / steps);
          moves.push(absoluteMove(px, py));
        }
        sendInputs(moves);
        await delay(16, signal);
        sendInputs([absoluteMove(toX, toY, flags.up)]);
        held = false;
      } finally {
        if (held) {
          try { sendInputs([absoluteMove(toX, toY, flags.up)]); } catch { /* 松开失败不再覆盖原来的错误 */ }
        }
      }
    },
    scroll(x, y, notches) {
      const events: DesktopInput[] = [];
      if (x !== null && y !== null) events.push(absoluteMove(x, y));
      events.push(mouseInput(0, 0, notches * WHEEL_DELTA, MOUSEEVENTF_WHEEL));
      sendInputs(events);
    },
    typeText(text) {
      const events = unicodeInputs(text);
      const chunk = 64;
      for (let i = 0; i < events.length; i += chunk) {
        sendInputs(events.slice(i, i + chunk));
      }
    },
    pressTokens(tokens) {
      const vks = expandTokens(tokens);
      const down = vks.map((vk) => keyInput(vk, 0, 0));
      const up = [...vks].reverse().map((vk) => keyInput(vk, 0, KEYEVENTF_KEYUP));
      sendInputs([...down, ...up]);
    },
    capturePrimary() {
      const virtual = virtualMetrics();
      const primary = primarySize();
      const fullDesktop = virtual.width * virtual.height > 0
        && virtual.width * virtual.height <= 16_000_000;
      const originX = fullDesktop ? virtual.left : 0;
      const originY = fullDesktop ? virtual.top : 0;
      const width = fullDesktop ? virtual.width : primary.width;
      const height = fullDesktop ? virtual.height : primary.height;
      const { x: cursorX, y: cursorY } = cursor();
      const screen = api.getDC(null);
      if (!screen) throw new Error(`GetDC failed (${api.getLastError()})`);
      let memory: unknown = null;
      let bitmap: unknown = null;
      try {
        memory = api.createCompatibleDC(screen);
        bitmap = api.createCompatibleBitmap(screen, width, height);
        if (!memory || !bitmap) throw new Error(`Could not create a screen bitmap (${api.getLastError()})`);
        const previous = api.selectObject(memory, bitmap);
        const copied = api.bitBlt(memory, 0, 0, width, height, screen, originX, originY, SRCCOPY);
        if (previous) api.selectObject(memory, previous);
        if (!copied) throw new Error(`BitBlt failed (${api.getLastError()})`);

        const bmi = Buffer.alloc(40);
        bmi.writeUInt32LE(40, 0);
        bmi.writeInt32LE(width, 4);
        bmi.writeInt32LE(height, 8);
        bmi.writeUInt16LE(1, 12);
        bmi.writeUInt16LE(32, 14);
        const stride = width * 4;
        bmi.writeUInt32LE(stride * height, 20);
        const pixels = Buffer.alloc(stride * height);
        const rows = api.getDIBits(memory, bitmap, 0, height, pixels, bmi, 0);
        if (rows !== height) throw new Error(`GetDIBits returned ${rows} rows, expected ${height}`);
        return { width, height, pixels, cursorX, cursorY, originX, originY, fullDesktop };
      } finally {
        if (bitmap) api.deleteObject(bitmap);
        if (memory) api.deleteDC(memory);
        api.releaseDC(null, screen);
      }
    },
  };
}

function dragSteps(x: number, y: number, toX: number, toY: number): number {
  const distance = Math.hypot(toX - x, toY - y);
  return Math.min(24, Math.max(2, Math.round(distance / 40)));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}
