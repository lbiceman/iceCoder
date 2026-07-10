/**
 * preload.ts — 暴露有限 IPC 给 renderer。
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
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
