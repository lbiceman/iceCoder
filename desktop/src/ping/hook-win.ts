/**
 * 低级键鼠钩子：按住 Ctrl 再按住左键拖动才打开轮盘。
 * 没拖开的点击会回放，Ctrl 键本身不吞。
 */
import koffi from 'koffi';
import {
  INITIAL_GESTURE,
  reduceGesture,
  type GestureEffect,
  type GestureInput,
  type GestureSnapshot,
} from './gesture';

const WH_KEYBOARD_LL = 13;
const WH_MOUSE_LL = 14;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_SYSKEYDOWN = 0x0104;
const WM_SYSKEYUP = 0x0105;
const LLMHF_INJECTED = 0x01;
const LLKHF_UP = 0x80;
const LLKHF_INJECTED = 0x10;
const VK_CONTROL = 0x11;
const VK_LCONTROL = 0xa2;
const VK_RCONTROL = 0xa3;
const VK_ESCAPE = 0x1b;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const WATCHDOG_MS = 10_000;

export interface ScreenPingHook {
  start(): void;
  stop(): void;
  setMarkerOpen(open: boolean): void;
  /** 轮盘开着但 10 秒没有输入时收起。 */
  pulse(now: number): void;
  abort(): void;
}

interface HookNative {
  setHook(id: number, proc: unknown, module: null, threadId: number): unknown;
  unhook(handle: unknown): number;
  callNext(hook: null, code: number, wParam: unknown, lParam: unknown): unknown;
  decodeMouse(lParam: unknown): { x: number; y: number; flags: number };
  decodeKey(lParam: unknown): { vkCode: number; flags: number };
  getCursorPos(point: Buffer): number;
  sendInput(count: number, inputs: unknown[], cbSize: number): number;
  inputSize: number;
  getSystemMetrics(index: number): number;
  procType: unknown;
}

let cachedNative: HookNative | null = null;

function loadNative(): HookNative {
  if (cachedNative) return cachedNative;
  const user32 = koffi.load('user32.dll');
  const mouseStruct = koffi.struct('IcePingMouseLL', {
    x: 'int32',
    y: 'int32',
    mouseData: 'uint32',
    flags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const keyStruct = koffi.struct('IcePingKeyLL', {
    vkCode: 'uint32',
    scanCode: 'uint32',
    flags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const hookProc = koffi.proto('intptr_t __stdcall IcePingHookProc(int nCode, uintptr_t wParam, intptr_t lParam)');
  const mouse = koffi.struct('IcePingMouseInput', {
    dx: 'int32',
    dy: 'int32',
    mouseData: 'int32',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const key = koffi.struct('IcePingKeyInput', {
    wVk: 'uint16',
    wScan: 'uint16',
    dwFlags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t',
  });
  const hardware = koffi.struct('IcePingHardwareInput', {
    uMsg: 'uint32',
    wParamL: 'uint16',
    wParamH: 'uint16',
  });
  const inputType = koffi.struct('IcePingInput', {
    type: 'uint32',
    u: koffi.union({ mi: mouse, ki: key, hi: hardware }),
  });
  cachedNative = {
    setHook: user32.func('void * __stdcall SetWindowsHookExW(int idHook, IcePingHookProc *lpfn, void *hMod, uint32 dwThreadId)') as HookNative['setHook'],
    unhook: user32.func('int __stdcall UnhookWindowsHookEx(void *hhk)') as HookNative['unhook'],
    callNext: user32.func('intptr_t __stdcall CallNextHookEx(void *hhk, int nCode, uintptr_t wParam, intptr_t lParam)') as HookNative['callNext'],
    decodeMouse: (lParam) => koffi.decode(lParam, mouseStruct) as { x: number; y: number; flags: number },
    decodeKey: (lParam) => koffi.decode(lParam, keyStruct) as { vkCode: number; flags: number },
    getCursorPos: user32.func('int __stdcall GetCursorPos(_Out_ uint8_t *point)') as HookNative['getCursorPos'],
    sendInput: user32.func('uint32 __stdcall SendInput(uint32 cInputs, IcePingInput *pInputs, int cbSize)') as HookNative['sendInput'],
    inputSize: koffi.sizeof(inputType),
    getSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int nIndex)') as HookNative['getSystemMetrics'],
    procType: koffi.pointer(hookProc),
  };
  return cachedNative;
}

function isCtrl(vk: number): boolean {
  return vk === VK_CONTROL || vk === VK_LCONTROL || vk === VK_RCONTROL;
}

export function createScreenPingHook(onEffect: (effect: GestureEffect) => void): ScreenPingHook {
  let native: HookNative | null = null;
  let mouseHook: unknown = null;
  let keyHook: unknown = null;
  let mouseProc: unknown = null;
  let keyProc: unknown = null;
  let state: GestureSnapshot = { ...INITIAL_GESTURE };
  let markerOpen = false;
  let ctrlHeld = false;
  let lastInputAt = 0;
  let moveQueued = false;
  let pendingMove: GestureEffect | null = null;

  function emit(effect: GestureEffect): void {
    if (effect.type === 'none') return;
    if (effect.type === 'move') {
      pendingMove = effect;
      if (moveQueued) return;
      moveQueued = true;
      setImmediate(() => {
        moveQueued = false;
        const move = pendingMove;
        pendingMove = null;
        if (move) onEffect(move);
      });
      return;
    }
    pendingMove = null;
    setImmediate(() => onEffect(effect));
  }

  function apply(input: GestureInput): { swallow: boolean } {
    const result = reduceGesture(state, input);
    state = result.state;
    if (result.replay) {
      const replay = result.replay;
      setImmediate(() => {
        try { replayClick(replay.x, replay.y); } catch { /* 回放失败不再抛回钩子 */ }
      });
    }
    emit(result.effect);
    return { swallow: result.swallow };
  }

  function replayClick(x: number, y: number): void {
    if (!native) return;
    const left = native.getSystemMetrics(76);
    const top = native.getSystemMetrics(77);
    const width = native.getSystemMetrics(78) || native.getSystemMetrics(0);
    const height = native.getSystemMetrics(79) || native.getSystemMetrics(1);
    const ax = Math.min(65535, Math.max(0, Math.round(((x - left) * 65535) / Math.max(width, 1))));
    const ay = Math.min(65535, Math.max(0, Math.round(((y - top) * 65535) / Math.max(height, 1))));
    const flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    const base = { mouseData: 0, time: 0, dwExtraInfo: 0 };
    native.sendInput(2, [
      { type: 0, u: { mi: { ...base, dx: ax, dy: ay, dwFlags: flags | MOUSEEVENTF_LEFTDOWN } } },
      { type: 0, u: { mi: { ...base, dx: ax, dy: ay, dwFlags: flags | MOUSEEVENTF_LEFTUP } } },
    ], native.inputSize);
  }

  function onMouse(nCode: number, wParam: unknown, lParam: unknown): unknown {
    if (!native || nCode < 0) return native ? native.callNext(null, nCode, wParam, lParam) : 0;
    try {
      const msg = Number(wParam);
      const info = native.decodeMouse(lParam);
      const injected = (info.flags & LLMHF_INJECTED) !== 0;
      lastInputAt = Date.now();
      let swallow = false;
      if (msg === WM_LBUTTONDOWN) {
        swallow = apply({ kind: 'mouseDown', x: info.x, y: info.y, trigger: ctrlHeld, injected }).swallow;
      } else if (msg === WM_MOUSEMOVE) {
        swallow = apply({ kind: 'mouseMove', x: info.x, y: info.y, injected }).swallow;
      } else if (msg === WM_LBUTTONUP) {
        swallow = apply({ kind: 'mouseUp', x: info.x, y: info.y, injected }).swallow;
      } else if (msg === WM_RBUTTONDOWN) {
        swallow = apply({ kind: 'rightDown', injected }).swallow;
      } else if (msg === WM_RBUTTONUP) {
        swallow = apply({ kind: 'rightUp', injected }).swallow;
      }
      if (swallow) return 1;
      return native.callNext(null, nCode, wParam, lParam);
    } catch {
      return native.callNext(null, nCode, wParam, lParam);
    }
  }

  function onKey(nCode: number, wParam: unknown, lParam: unknown): unknown {
    if (!native || nCode < 0) return native ? native.callNext(null, nCode, wParam, lParam) : 0;
    try {
      const msg = Number(wParam);
      const info = native.decodeKey(lParam);
      const injected = (info.flags & LLKHF_INJECTED) !== 0;
      const up = msg === WM_KEYUP || msg === WM_SYSKEYUP || (info.flags & LLKHF_UP) !== 0;
      if (!injected) lastInputAt = Date.now();
      let swallow = false;
      if (!injected && isCtrl(info.vkCode) && !up) {
        ctrlHeld = true;
      } else if (!injected && isCtrl(info.vkCode) && up) {
        ctrlHeld = false;
        swallow = apply({ kind: 'triggerUp' }).swallow;
      } else if (!injected && !up && info.vkCode === VK_ESCAPE && (msg === WM_KEYDOWN || msg === WM_SYSKEYDOWN)) {
        swallow = apply({ kind: 'escape', markerOpen }).swallow;
      } else if (!injected && !up && (msg === WM_KEYDOWN || msg === WM_SYSKEYDOWN)) {
        swallow = apply({ kind: 'otherKey' }).swallow;
      }
      if (swallow) return 1;
      return native.callNext(null, nCode, wParam, lParam);
    } catch {
      return native.callNext(null, nCode, wParam, lParam);
    }
  }

  return {
    start() {
      if (mouseHook || process.platform !== 'win32') return;
      native = loadNative();
      mouseProc = koffi.register(onMouse, native.procType as never);
      keyProc = koffi.register(onKey, native.procType as never);
      mouseHook = native.setHook(WH_MOUSE_LL, mouseProc, null, 0);
      keyHook = native.setHook(WH_KEYBOARD_LL, keyProc, null, 0);
      if (!mouseHook || !keyHook) {
        this.stop();
        throw new Error('SetWindowsHookEx failed');
      }
      state = { ...INITIAL_GESTURE };
      ctrlHeld = false;
      lastInputAt = Date.now();
    },
    stop() {
      if (native && mouseHook) native.unhook(mouseHook);
      if (native && keyHook) native.unhook(keyHook);
      mouseHook = null;
      keyHook = null;
      mouseProc = null;
      keyProc = null;
      state = { ...INITIAL_GESTURE };
      ctrlHeld = false;
      pendingMove = null;
    },
    setMarkerOpen(open: boolean) {
      markerOpen = open;
    },
    pulse(now: number) {
      if (!mouseHook) return;
      if (state.phase === 'idle') return;
      if (now - lastInputAt < WATCHDOG_MS) return;
      lastInputAt = now;
      apply({ kind: 'abort' });
    },
    abort() {
      if (!mouseHook) {
        state = { ...INITIAL_GESTURE };
        return;
      }
      apply({ kind: 'abort' });
    },
  };
}
