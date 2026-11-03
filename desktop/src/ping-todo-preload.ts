/**
 * 待办草稿窗的 preload。只把输入、框选和取消交回主进程。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from './constants';

contextBridge.exposeInMainWorld('todoDraft', {
  submit(text: string) {
    ipcRenderer.send(IPC.TODO_DRAFT_SUBMIT, { text });
  },
  snip(text: string) {
    ipcRenderer.send(IPC.TODO_DRAFT_SNIP, { text });
  },
  cancel() {
    ipcRenderer.send(IPC.TODO_DRAFT_CANCEL);
  },
  onState(cb: (state: unknown) => void) {
    const listener = (_event: IpcRendererEvent, state: unknown) => cb(state);
    ipcRenderer.on(IPC.TODO_DRAFT_STATE, listener);
  },
});
