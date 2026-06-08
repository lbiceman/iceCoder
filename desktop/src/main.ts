/**
 * main.ts — Electron 主进程入口
 */
import { writeConsole } from './console-output';
import { ensureWinConsoleUtf8 } from './win-console-utf8';
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, Tray, nativeImage } from 'electron';

ensureWinConsoleUtf8();
import path from 'node:path';
import os from 'node:os';
import { IPC, APP_NAME, DEFAULT_HTTP_PORT } from './constants';
import { getAvailablePort } from './port-utils';
import { startServerProcess, ServerProcessHandle } from './server-process';
import { readWorkspace, writeWorkspace, resolveServerCwd, isServerBundleReady } from './paths';
import { buildTray } from './tray';
import { PetWindowManager } from './pet-window-manager';

let mainWindow: BrowserWindow | null = null;
let serverHandle: ServerProcessHandle | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const petManager = new PetWindowManager();

function resolveAppIcon(): Electron.NativeImage {
  const assetsDir = path.join(__dirname, '..', 'assets');
  const candidates =
    process.platform === 'win32'
      ? ['icon.ico', 'icon.png']
      : ['icon.png', 'icon.ico'];
  for (const name of candidates) {
    const image = nativeImage.createFromPath(path.join(assetsDir, name));
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

async function createMainWindow(url: string): Promise<BrowserWindow> {
  const appIcon = resolveAppIcon();
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e0f12',
    title: APP_NAME,
    ...(appIcon.isEmpty() ? {} : { icon: appIcon }),
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
  ipcMain.on(IPC.PET_DRAG_MOVE, (_e: Electron.IpcMainEvent, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const { dx, dy } = payload as { dx?: unknown; dy?: unknown };
    if (typeof dx !== 'number' || typeof dy !== 'number') return;
    petManager.moveFloatingBy(dx, dy);
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
  if (isQuitting) return;
  isQuitting = true;

  try { petManager.destroy(); } catch { /* ignore */ }

  if (tray && !tray.isDestroyed()) {
    try { tray.destroy(); } catch { /* ignore */ }
    tray = null;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeAllListeners('close');
    try { mainWindow.destroy(); } catch { /* ignore */ }
    mainWindow = null;
  }

  if (serverHandle) {
    try { await serverHandle.stop(); } catch { /* ignore */ }
    serverHandle = null;
  }

  app.exit(0);
}

async function bootstrap(): Promise<void> {
  if (!isServerBundleReady()) {
    throw new Error(
      '未找到 desktop/server-bundle。请在仓库根目录执行：npm run build:desktop:server',
    );
  }
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

  petManager.setContext(mainWindow, url);
  void petManager.enterEmbeddedMode(mainWindow);

  // 5) 主窗生命周期 ↔ pet 状态机
  mainWindow.on('minimize', () => { if (mainWindow) void petManager.enterFloatingMode(mainWindow); });
  mainWindow.on('hide', () => { if (mainWindow) void petManager.enterFloatingMode(mainWindow); });
  mainWindow.on('restore', () => { if (mainWindow) void petManager.enterEmbeddedMode(mainWindow); });
  mainWindow.on('show', () => { if (mainWindow) void petManager.enterEmbeddedMode(mainWindow); });
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    void gracefulShutdown();
  });

  // 6) 顶栏原生菜单暂隐藏（原仅「帮助」一项）
  Menu.setApplicationMenu(null);

  tray = buildTray(mainWindow, {
    showMain: () => showAndFocusMain(),
    quit: () => { void gracefulShutdown(); },
  });
}

app.on('window-all-closed', () => {
  if (isQuitting) return;
  if (process.platform !== 'darwin') {
    void gracefulShutdown();
  }
});

app.on('before-quit', (e) => {
  if (isQuitting) return;
  e.preventDefault();
  void gracefulShutdown();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
    void createMainWindow(serverHandle.url);
  } else {
    showAndFocusMain();
  }
});

app.whenReady().then(() => {
  const appIcon = resolveAppIcon();
  if (!appIcon.isEmpty() && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(appIcon);
  }
  bootstrap().catch((err) => {
    writeConsole(process.stderr, `[main] bootstrap failed: ${err && err.stack || err}\n`);
    void dialog.showErrorBox('iceCoder 启动失败', String(err?.message || err));
    app.exit(1);
  });
});
