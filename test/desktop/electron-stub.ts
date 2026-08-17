/**
 * electron 模块测试替身（vitest alias 'electron' → 本文件）。
 *
 * 真实 electron 包在纯 Node 环境下无法 import（导出的是可执行文件路径），
 * desktop 单测统一走此 stub，按需提供模块用到的 API。
 */
import os from 'node:os';

let userDataDir = '';

/** 测试中设置 app.getPath('userData') 的返回值。 */
export function setStubUserData(dir: string): void {
  userDataDir = dir;
}

export const app = {
  isPackaged: false,
  getPath: (name: string): string => (name === 'userData' && userDataDir ? userDataDir : os.tmpdir()),
  on: () => app,
  once: () => app,
  whenReady: async (): Promise<void> => undefined,
  quit: (): void => undefined,
  getVersion: (): string => '0.0.0-test',
};

const noopWindowMethod = (): unknown => undefined;

function webContentsStub() {
  return {
    send: noopWindowMethod,
    once: (_event: string, cb: () => void) => cb(),
    on: noopWindowMethod,
  };
}

export class BrowserWindow {
  static getAllWindows = (): BrowserWindow[] => [];
  webContents = webContentsStub();
  isDestroyed = (): boolean => false;
  isFocused = (): boolean => false;
  isMinimized = (): boolean => false;
  isVisible = (): boolean => true;
  show = noopWindowMethod;
  hide = noopWindowMethod;
  focus = noopWindowMethod;
  restore = noopWindowMethod;
  destroy = noopWindowMethod;
  close = noopWindowMethod;
  getBounds = (): Electron.Rectangle => ({ x: 0, y: 0, width: 1280, height: 860 });
  setPosition = noopWindowMethod;
  getPosition = (): number[] => [0, 0];
  setIgnoreMouseEvents = noopWindowMethod;
  setAlwaysOnTop = noopWindowMethod;
  setVisibleOnAllWorkspaces = noopWindowMethod;
  setSize = noopWindowMethod;
  setTitle = noopWindowMethod;
  loadURL = async (): Promise<void> => undefined;
  removeAllListeners = noopWindowMethod;
  on = noopWindowMethod;
  once = noopWindowMethod;
}

const WORK_AREA: Electron.Rectangle = { x: 0, y: 0, width: 1920, height: 1080 };

export const screen = {
  getPrimaryDisplay: (): Electron.Display =>
    ({ workArea: { ...WORK_AREA }, bounds: { ...WORK_AREA }, scaleFactor: 1 } as Electron.Display),
  getDisplayMatching: (): Electron.Display =>
    ({ workArea: { ...WORK_AREA }, bounds: { ...WORK_AREA }, scaleFactor: 1 } as Electron.Display),
};

export class Tray {
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): void {}
  destroy(): void {}
  isDestroyed(): boolean {
    return false;
  }
}

export const Menu = {
  buildFromTemplate: (template: unknown[]) => template,
};

export const nativeImage = {
  createFromPath: () => ({
    isEmpty: (): boolean => true,
    resize: () => ({ isEmpty: (): boolean => true }),
    getSize: () => ({ width: 16, height: 16 }),
  }),
  createEmpty: () => ({
    isEmpty: (): boolean => true,
    resize: () => ({ isEmpty: (): boolean => true }),
    getSize: () => ({ width: 0, height: 0 }),
  }),
};

export class Notification {
  show = noopWindowMethod;
  close = noopWindowMethod;
  on = noopWindowMethod;
}

export const ipcMain = {
  on: noopWindowMethod,
  handle: noopWindowMethod,
};

export const dialog = {
  showOpenDialog: async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({ canceled: true, filePaths: [] }),
  showMessageBox: async (): Promise<{ response: number }> => ({ response: 0 }),
};

export const shell = {
  openPath: async (): Promise<string> => '',
  openExternal: async (): Promise<void> => undefined,
};

export const contextBridge = {
  exposeInMainWorld: noopWindowMethod,
};

export const ipcRenderer = {
  send: noopWindowMethod,
  invoke: async (): Promise<unknown> => undefined,
  on: noopWindowMethod,
  removeListener: noopWindowMethod,
};

export type IpcMainEvent = {
  reply: noopWindowMethod;
  sender: unknown;
};
