/**
 * 问号浮层专用 preload。只收主进程推来的轮盘和回答。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from './constants';

contextBridge.exposeInMainWorld('pingOverlay', {
  onWheel(cb: (payload: unknown) => void) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(IPC.SCREEN_PING_WHEEL, listener);
  },
  onMarker(cb: (payload: unknown) => void) {
    const listener = (_event: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(IPC.SCREEN_PING_MARKER, listener);
  },
});
