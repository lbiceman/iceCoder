/**
 * preload.ts — 暴露有限 IPC 给 renderer。
 */
import { clipboard, contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import { IPC } from './constants';

const api = {
  /** 拉取当前冰豆显示模式：'embedded' | 'floating' | 'hidden' */
  petGetMode: (): Promise<string> => ipcRenderer.invoke(IPC.PET_GET_MODE),

  /** 主窗冰豆上报当前状态快照给 Main。 */
  petPushState: (state: unknown) => ipcRenderer.send(IPC.PET_STATE_PUSH, state),

  /** 桌面悬浮冰豆请求显示/隐藏主窗内嵌冰豆。 */
  petSetEmbedded: (visible: boolean) =>
    ipcRenderer.invoke(IPC.PET_SET_EMBEDDED, visible),

  /** 双击悬浮冰豆 → 请求恢复并聚焦主窗。 */
  petRequestShowMain: () => ipcRenderer.send(IPC.PET_REQUEST_SHOW_MAIN),

  /** 悬浮冰豆拖动事件（由 floating-renderer 主动通知 main）。 */
  petDragMove: (dx: number, dy: number) =>
    ipcRenderer.send(IPC.PET_DRAG_MOVE, { dx, dy }),
  petDragEnd: (x: number, y: number) =>
    ipcRenderer.send(IPC.PET_DRAG_END, { x, y }),

  /** true=透明区点击穿透；false=悬浮窗接收鼠标（仅 canvas 命中时应为 false）。 */
  petSetMousePassthrough: (passthrough: boolean) =>
    ipcRenderer.send(IPC.PET_SET_MOUSE_PASSTHROUGH, { passthrough }),

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

  /** 监听 main → renderer 的事件。 */
  onPetMode: (cb: (mode: string) => void) => {
    const listener = (_e: IpcRendererEvent, mode: string) => cb(mode);
    ipcRenderer.on('pet:mode', listener);
    return () => ipcRenderer.removeListener('pet:mode', listener);
  },
  onPetStateSnapshot: (cb: (snapshot: unknown) => void) => {
    const listener = (_e: IpcRendererEvent, snapshot: unknown) => cb(snapshot);
    ipcRenderer.on('pet:state-snapshot', listener);
    return () => ipcRenderer.removeListener('pet:state-snapshot', listener);
  },
  onPetForceVisible: (cb: (visible: boolean) => void) => {
    const listener = (_e: IpcRendererEvent, visible: boolean) => cb(visible);
    ipcRenderer.on('pet:force-visible', listener);
    return () => ipcRenderer.removeListener('pet:force-visible', listener);
  },
};

contextBridge.exposeInMainWorld('iceDesktop', api);

export type IceDesktopApi = typeof api;
