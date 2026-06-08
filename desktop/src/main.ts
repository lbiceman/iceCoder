/**
 * main.ts — Electron 主进程入口
 */
import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { IPC, APP_NAME, DEFAULT_HTTP_PORT } from './constants';
import { getAvailablePort } from './port-utils';
import { startServerProcess, ServerProcessHandle } from './server-process';
import { readWorkspace, writeWorkspace, resolveServerCwd } from './paths';
import { buildAppMenu } from './menu';
import { buildTray } from './tray';
import { PetWindowManager } from './pet-window-manager';

let mainWindow: BrowserWindow | null = null;
let serverHandle: ServerProcessHandle | null = null;
const petManager = new PetWindowManager();

async function createMainWindow(url: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e0f12',
    title: APP_NAME,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    void win.show();
  });

  await win.loadURL(url);

  // 失焦时不强制隐藏，让用户切回浏览器对照配置页
  return win;
}

async function pickWorkspaceInteractive(): Promise<string | null> {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择工作区文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const ws = result.filePaths[0];
  writeWorkspace(ws);
  return ws;
}

function broadcastWorkspace(ws: string | null): void {
  mainWindow?.webContents.send(IPC.WORKSPACE_CHANGED, ws);
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.PET_GET_MODE, () => petManager.getMode());
  ipcMain.handle(IPC.PET_SET_EMBEDDED, (_e: Electron.IpcMainInvokeEvent, visible: boolean) => {
    if (mainWindow) {
      mainWindow.webContents.send('pet:force-visible', !!visible);
    }
    return petManager.getMode();
  });
  ipcMain.on(IPC.PET_STATE_PUSH, (_e: Electron.IpcMainEvent, snapshot: unknown) => {
    petManager.pushSnapshot(snapshot);
  });
  ipcMain.on(IPC.PET_REQUEST_SHOW_MAIN, () => {
    showAndFocusMain();
  });
  ipcMain.on(IPC.PET_DRAG_MOVE, () => {
    // floating-renderer 自行通过 -webkit-app-region: drag 处理拖动；
    // 此处保留通道位便于将来支持 programmatic move。
  });
  ipcMain.on(IPC.PET_DRAG_END, (_e: Electron.IpcMainEvent, pos: unknown) => {
    if (
      pos && typeof pos === 'object' &&
      typeof (pos as { x?: unknown }).x === 'number' &&
      typeof (pos as { y?: unknown }).y === 'number'
    ) {
      // 位置已由 pet-window-manager 的 'moved' 监听器持久化；
      // 此处保留通道位便于将来支持 programmatic move。
    }
  });

  ipcMain.handle(IPC.WORKSPACE_PICK, async () => {
    const ws = await pickWorkspaceInteractive();
    broadcastWorkspace(ws);
    return ws;
  });
  ipcMain.handle(IPC.WORKSPACE_GET, () => readWorkspace());

  ipcMain.on(IPC.APP_OPEN_DATA_DIR, () => {
    const dataDir = path.join(os.homedir(), '.iceCoder');
    void shell.openPath(dataDir);
  });
  ipcMain.on(IPC.APP_DEVTOOLS, () => {
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });
  ipcMain.on(IPC.APP_QUIT, () => {
    void gracefulShutdown();
  });
}

function showAndFocusMain(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  void petManager.enterEmbeddedMode(mainWindow);
}

async function gracefulShutdown(): Promise<void> {
  try { petManager.hide(); } catch { /* ignore */ }
  try { if (serverHandle) await serverHandle.stop(); } catch { /* ignore */ }
  app.quit();
}

async function bootstrap(): Promise<void> {
  // 1) 探测端口
  const port = await getAvailablePort(DEFAULT_HTTP_PORT, 50);
  // 2) 启动 server 子进程
  serverHandle = await startServerProcess({
    port,
    cwd: resolveServerCwd(),
  });
  const url = `http://127.0.0.1:${port}`;

  // 3) 主窗
  mainWindow = await createMainWindow(url);
  registerIpcHandlers();

  // 4) 冰豆模式：默认 embedded
  petManager.setSnapshotSink((s) => {
    // 由 floating-renderer 通过 pet:state-snapshot 接收
    if (s) { /* 状态已转发到 floating.webContents.send('pet:state-snapshot', s) */ }
  });
  void petManager.enterEmbeddedMode(mainWindow);

  // 5) 主窗生命周期 ↔ pet 状态机
  mainWindow.on('minimize', () => { void petManager.enterFloatingMode(); });
  mainWindow.on('hide', () => { void petManager.enterFloatingMode(); });
  mainWindow.on('restore', () => { if (mainWindow) void petManager.enterEmbeddedMode(mainWindow); });
  mainWindow.on('show', () => { if (mainWindow) void petManager.enterEmbeddedMode(mainWindow); });
  mainWindow.on('close', () => { void petManager.enterFloatingMode(); });

  // 6) 菜单 + 托盘
  const menu = buildAppMenu({
    pickWorkspace: async (): Promise<string | null> => {
      const ws = await pickWorkspaceInteractive();
      broadcastWorkspace(ws);
      return ws;
    },
    openDataDir: () => {
      const dataDir = path.join(os.homedir(), '.iceCoder');
      void shell.openPath(dataDir);
    },
    openDevTools: () => mainWindow?.webContents.openDevTools({ mode: 'detach' }),
    quit: () => { void gracefulShutdown(); },
  });
  Menu.setApplicationMenu(menu);

  buildTray(mainWindow, {
    showMain: () => showAndFocusMain(),
    quit: () => { void gracefulShutdown(); },
  });
}

app.on('window-all-closed', () => {
  // macOS 习惯：所有窗口关闭后保留 dock 入口
  if (process.platform !== 'darwin') {
    void gracefulShutdown();
  }
});

app.on('before-quit', async (e: Electron.Event) => {
  if (serverHandle) {
    e.preventDefault();
    try { await serverHandle.stop(); } catch { /* ignore */ }
    serverHandle = null;
    app.exit(0);
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
    void createMainWindow(serverHandle.url);
  } else {
    showAndFocusMain();
  }
});

app.whenReady().then(() => {
  bootstrap().catch((err) => {
    process.stderr.write(`[main] bootstrap failed: ${err && err.stack || err}\n`);
    void dialog.showErrorBox('iceCoder 启动失败', String(err?.message || err));
    app.exit(1);
  });
});
