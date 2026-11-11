/**
 * preload.ts — 暴露有限 IPC 给 renderer。
 */
import { clipboard, contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC } from './constants';
import { windowChromeKind, windowUsesCustomControls } from './window-chrome';

const api = {
  /** 屏幕问号轮盘。supported 为 false 时设置页只展示、不能开。 */
  getScreenPing: (): Promise<{ supported: boolean; enabled: boolean; cropWidth: number; cropHeight: number }> =>
    ipcRenderer.invoke(IPC.SCREEN_PING_GET),
  setScreenPing: (patch: { enabled?: boolean; cropWidth?: number; cropHeight?: number }): Promise<{ supported: boolean; enabled: boolean; cropWidth: number; cropHeight: number }> =>
    ipcRenderer.invoke(IPC.SCREEN_PING_SET, patch),
  /** 正下方截图放进输入框。 */
  onScreenPingPaste: (cb: (dataUrl: string) => void) => {
    const listener = (_e: IpcRendererEvent, dataUrl: string) => cb(dataUrl);
    ipcRenderer.on(IPC.SCREEN_PING_PASTE, listener);
    return () => ipcRenderer.removeListener(IPC.SCREEN_PING_PASTE, listener);
  },

  /** 工作区。 */
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke(IPC.WORKSPACE_PICK),
  getWorkspace: (): Promise<string | null> => ipcRenderer.invoke(IPC.WORKSPACE_GET),
  onWorkspaceChanged: (cb: (ws: string | null) => void) => {
    const listener = (_e: IpcRendererEvent, ws: string | null) => cb(ws);
    ipcRenderer.on(IPC.WORKSPACE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.WORKSPACE_CHANGED, listener);
  },

  /** iceCoder 数据目录（重启后生效）。 */
  getDataDirectory: (): Promise<string> => ipcRenderer.invoke(IPC.DATA_DIRECTORY_GET),
  pickDataDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.DATA_DIRECTORY_PICK),
  setDataDirectory: (dataDir: string | null): Promise<string> =>
    ipcRenderer.invoke(IPC.DATA_DIRECTORY_SET, dataDir),

  /** 应用级。 */
  openDataDir: () => ipcRenderer.send(IPC.APP_OPEN_DATA_DIR),
  quit: () => ipcRenderer.send(IPC.APP_QUIT),
  openDevTools: () => ipcRenderer.send(IPC.APP_DEVTOOLS),

  /** false：不在网页里画最小化 / 最大化 / 关闭。 */
  windowControls: windowUsesCustomControls(),
  /** overlay：Windows / Linux 系统按钮。traffic-lights：macOS 红绿灯。 */
  windowChrome: windowChromeKind(),
  windowSetTitleBarOverlay: (colors: { color: string; symbolColor: string }) => {
    ipcRenderer.send(IPC.WINDOW_SET_TITLEBAR_OVERLAY, colors);
  },
  windowMinimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  windowToggleMaximize: () => ipcRenderer.send(IPC.WINDOW_TOGGLE_MAXIMIZE),
  windowClose: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
  windowGetChromeState: (): Promise<{ maximized: boolean; focused: boolean }> =>
    ipcRenderer.invoke(IPC.WINDOW_CHROME_STATE),
  onWindowMaximized: (cb: (maximized: boolean) => void) => {
    const listener = (_e: IpcRendererEvent, maximized: boolean) => cb(!!maximized);
    ipcRenderer.on(IPC.WINDOW_MAXIMIZED_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZED_CHANGED, listener);
  },
  onWindowFocus: (cb: (focused: boolean) => void) => {
    const listener = (_e: IpcRendererEvent, focused: boolean) => cb(!!focused);
    ipcRenderer.on(IPC.WINDOW_FOCUS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.WINDOW_FOCUS_CHANGED, listener);
  },

  /**
   * 读取系统剪贴板中的位图。Electron 里 Win+Shift+S / 微信截图等常常
   * 不进入 renderer 的 clipboardData.items，只能从 native clipboard 取。
   */
  readClipboardImage: (): { mime: string; base64: string } | null => {
    try {
      const img = clipboard.readImage();
      if (!img || img.isEmpty()) return null;
      const png = img.toPNG();
      if (!png || png.length === 0) return null;
      return { mime: 'image/png', base64: Buffer.from(png).toString('base64') };
    } catch {
      return null;
    }
  },

  /** 任务完成系统通知（payload: { success: boolean; summary: string; sessionId?: string }）。 */
  notifyTaskDone: (payload: { success: boolean; summary: string; sessionId?: string }) =>
    ipcRenderer.send(IPC.TASK_DONE_NOTIFY, payload),

  onTaskDoneNotifyClick: (cb: (sessionId: string) => void) => {
    const listener = (_e: IpcRendererEvent, sessionId: string) => cb(sessionId);
    ipcRenderer.on(IPC.TASK_DONE_NOTIFY_CLICK, listener);
    return () => ipcRenderer.removeListener(IPC.TASK_DONE_NOTIFY_CLICK, listener);
  },
};

contextBridge.exposeInMainWorld('iceDesktop', api);

export type IceDesktopApi = typeof api;
