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

/** IPC 通道常量（preload / renderer 共享）。 */
export const IPC = {
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
  /** 自绘标题栏：最小化 / 最大化切换 / 关闭。 */
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  /** 渲染进程拉取当前是否最大化、是否聚焦。 */
  WINDOW_CHROME_STATE: 'window:chrome-state',
  WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',
  WINDOW_FOCUS_CHANGED: 'window:focus-changed',

  /** 渲染层请求系统通知（任务完成提醒）。 */
  TASK_DONE_NOTIFY: 'task:done-notify',
  /** 用户点击系统通知后，主进程通知渲染层切到对应会话。 */
  TASK_DONE_NOTIFY_CLICK: 'task:done-notify-click',

  /** 屏幕问号轮盘开关（设置页 ↔ 主进程）。 */
  SCREEN_PING_GET: 'screen-ping:get',
  SCREEN_PING_SET: 'screen-ping:set',
  /** 主进程 → 浮层：轮盘与落点回答。 */
  SCREEN_PING_WHEEL: 'screen-ping:wheel',
  SCREEN_PING_MARKER: 'screen-ping:marker',
  /** 主进程 → 浮层：轮盘上除问号以外的标记。 */
  SCREEN_PING_SIGNAL: 'screen-ping:signal',
  /** 主进程 → 浮层：右侧框选截图。 */
  SCREEN_PING_SNIP: 'screen-ping:snip',
  /** 浮层 → 主进程：框选完成或取消。 */
  SCREEN_PING_SNIP_RESULT: 'screen-ping:snip-result',
  /** 主进程 → 主窗口：把截图放进输入框。 */
  SCREEN_PING_PASTE: 'screen-ping:paste',
  /** 主进程 → 待办草稿窗：当前文字、截图和错误。 */
  TODO_DRAFT_STATE: 'todo-draft:state',
  /** 待办草稿窗 → 主进程。 */
  TODO_DRAFT_SUBMIT: 'todo-draft:submit',
  TODO_DRAFT_SNIP: 'todo-draft:snip',
  TODO_DRAFT_CANCEL: 'todo-draft:cancel',
} as const;

export type IpcChannel = typeof IPC[keyof typeof IPC];

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
