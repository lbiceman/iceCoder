/**
 * 桌面端常量
 */
import { app } from 'electron';
import path from 'node:path';

export const APP_NAME = 'iceCoder';

/** Windows 系统通知左上角来源名（toast 应用标识）。 */
export const NOTIFICATION_APP_NAME = 'iceCoder消息';

/** electron-builder appId，与 desktop/package.json build.appId 一致。 */
export const APP_USER_MODEL_ID = 'com.icecoder.app';

/** 主进程传给子进程的环境变量标记。 */
export const ENV_ELECTRON = 'ICE_ELECTRON';
export const ENV_PORT = 'PORT';
export const ENV_NODE_ENV = 'NODE_ENV';
export const ENV_SERVER_ROOT = 'ICE_SERVER_ROOT';
export const ENV_ICE_DATA_DIR = 'ICE_DATA_DIR';

/** 默认主进程监听 HTTP 端口起始（由 port-utils 探测空闲）。 */
export const DEFAULT_HTTP_PORT = 1024;

/** server health check 端点（Express /）。 */
export const HEALTHCHECK_PATH = '/';
/** health check 单次超时（ms） */
export const HEALTHCHECK_TIMEOUT_MS = 1500;
/** health check 总超时（ms） */
export const HEALTHCHECK_MAX_WAIT_MS = 30_000;

/** IPC 通道常量（preload / renderer / floating 共享）。 */
export const IPC = {
  // 主窗 ↔ Main
  PET_GET_MODE: 'pet:get-mode',
  PET_STATE_PUSH: 'pet:state-push',
  PET_SET_EMBEDDED: 'pet:set-embedded',
  PET_REQUEST_SHOW_MAIN: 'pet:request-show-main',
  PET_REQUEST_FOCUS_MAIN: 'pet:request-focus-main',
  PET_DRAG_MOVE: 'pet:drag-move',
  PET_DRAG_END: 'pet:drag-end',
  /** 悬浮窗透明区点击穿透（true=穿透，false=可点冰豆） */
  PET_SET_MOUSE_PASSTHROUGH: 'pet:set-mouse-passthrough',

  // 工作区
  WORKSPACE_PICK: 'workspace:pick',
  WORKSPACE_GET: 'workspace:get',
  WORKSPACE_CHANGED: 'workspace:changed',

  // 数据目录
  DATA_DIRECTORY_GET: 'data-directory:get',
  DATA_DIRECTORY_PICK: 'data-directory:pick',
  DATA_DIRECTORY_SET: 'data-directory:set',

  // 应用
  APP_OPEN_DATA_DIR: 'app:open-data-dir',
  APP_QUIT: 'app:quit',
  APP_DEVTOOLS: 'app:devtools',

  /** 渲染层请求系统通知（任务完成提醒）。 */
  TASK_DONE_NOTIFY: 'task:done-notify',
  /** 用户点击系统通知后，主进程通知渲染层切到对应会话。 */
  TASK_DONE_NOTIFY_CLICK: 'task:done-notify-click',
} as const;

export type IpcChannel = typeof IPC[keyof typeof IPC];

/** 进程模式。 */
export type PetDisplayMode = 'embedded' | 'floating' | 'hidden';

/** 是否处于打包后（app.isPackaged）。 */
export function isPackaged(): boolean {
  return app.isPackaged;
}

/** extraResources/server 解析。 */
export function getServerRoot(): string {
  if (isPackaged()) {
    return path.join(process.resourcesPath, 'server');
  }
  return path.join(__dirname, '..', 'server-bundle');
}

/** userData 根（Electron 标准）。 */
export function getUserDataDir(): string {
  return app.getPath('userData');
}
