/**
 * main.ts — Electron 主进程入口
 */
import { writeConsole } from './console-output';
import { ensureWinConsoleUtf8 } from './win-console-utf8';
import { app, BrowserWindow, dialog, ipcMain, shell, Menu, Tray, nativeImage, Notification } from 'electron';

ensureWinConsoleUtf8();
import path from 'node:path';
import { IPC, APP_NAME, DEFAULT_HTTP_PORT } from './constants';
import { getAvailablePort } from './port-utils';
import { startServerProcess, ServerProcessHandle } from './server-process';
import {
  readWorkspace,
  writeWorkspace,
  writeDataDirectory,
  resolveDataDirectory,
  resolveServerCwd,
  isServerBundleReady,
} from './paths';
import { buildTray } from './tray';
import { resolveTaskDoneNotification } from './task-done-notify';
import { configureWindowsNotificationIdentity } from './win-notification-shortcut';
import { createScreenPingController, type ScreenPingController } from './ping/controller';
import { readScreenPingSettings, writeScreenPingSettings } from './ping/settings';
import { applyWindowCommand, mainWindowChromeFields, startupDocumentHtml, WINDOW_CAPTION_HEIGHT } from './window-chrome';

let mainWindow: BrowserWindow | null = null;
let screenPing: ScreenPingController | null = null;
let serverHandle: ServerProcessHandle | null = null;
let tray: Tray | null = null;
let isQuitting = false;
const startupStartedAt = performance.now();

function logStartupTiming(phase: string): void {
  writeConsole(process.stdout, `[startup] main ${phase} +${Math.round(performance.now() - startupStartedAt)}ms\n`);
}

function resolveDesktopAssetsDir(): string {
  return path.join(__dirname, '..', 'assets');
}

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

/**
 * 纯文字系统通知。
 * Windows 标题栏小标由 AUMID / 开始菜单快捷方式的 icon.ico 提供；
 * 不要传 Notification.icon，否则会在正文左侧再画一张大图。
 */
function showTaskDoneSystemNotification(decision: {
  title: string;
  body: string;
}): Electron.Notification {
  return new Notification({
    title: decision.title,
    body: decision.body,
    silent: false,
  });
}

function windowFromSender(sender: Electron.WebContents): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.isDestroyed()) return null;
  return win;
}

function sendWindowChrome(win: BrowserWindow, channel: string, payload: unknown): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
    /* 页面切换中，下一次状态事件会再发 */
  }
}

function bindWindowChromeState(win: BrowserWindow): void {
  const publishMaximized = (): void => {
    if (win.isDestroyed()) return;
    sendWindowChrome(win, IPC.WINDOW_MAXIMIZED_CHANGED, win.isMaximized() || win.isFullScreen());
  };
  win.on('maximize', publishMaximized);
  win.on('unmaximize', publishMaximized);
  win.on('enter-full-screen', publishMaximized);
  win.on('leave-full-screen', publishMaximized);
  win.on('focus', () => sendWindowChrome(win, IPC.WINDOW_FOCUS_CHANGED, true));
  win.on('blur', () => sendWindowChrome(win, IPC.WINDOW_FOCUS_CHANGED, false));
}

let windowChromeIpcReady = false;

function registerWindowChromeIpc(): void {
  if (windowChromeIpcReady) return;
  windowChromeIpcReady = true;
  ipcMain.on(IPC.WINDOW_MINIMIZE, (e) => {
    const win = windowFromSender(e.sender);
    if (win) applyWindowCommand(win, 'minimize');
  });
  ipcMain.on(IPC.WINDOW_TOGGLE_MAXIMIZE, (e) => {
    const win = windowFromSender(e.sender);
    if (win) applyWindowCommand(win, 'toggle-maximize');
  });
  ipcMain.on(IPC.WINDOW_CLOSE, (e) => {
    const win = windowFromSender(e.sender);
    if (win) applyWindowCommand(win, 'close');
  });
  ipcMain.handle(IPC.WINDOW_CHROME_STATE, (e) => {
    const win = windowFromSender(e.sender);
    if (!win) return { maximized: false, focused: false };
    return {
      maximized: win.isMaximized() || win.isFullScreen(),
      focused: win.isFocused(),
    };
  });
  ipcMain.on(IPC.WINDOW_SET_TITLEBAR_OVERLAY, (e, payload: unknown) => {
    const win = windowFromSender(e.sender);
    if (!win) return;
    const color = readOverlayHex(payload, 'color');
    const symbolColor = readOverlayHex(payload, 'symbolColor');
    if (!color || !symbolColor) return;
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: WINDOW_CAPTION_HEIGHT });
    } catch {
      /* 这个窗口创建时没有系统按钮覆盖层 */
    }
  });
}

function readOverlayHex(payload: unknown, key: 'color' | 'symbolColor'): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as { color?: unknown; symbolColor?: unknown })[key];
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
}

function createWindow(show: boolean): BrowserWindow {
  const appIcon = resolveAppIcon();
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show,
    backgroundColor: '#0e0f12',
    title: APP_NAME,
    ...mainWindowChromeFields(),
    ...(appIcon.isEmpty() ? {} : { icon: appIcon }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  bindMainWindowCloseHandler(win);
  bindWindowChromeState(win);
  return win;
}

async function createStartupWindow(): Promise<BrowserWindow> {
  const win = createWindow(false);
  win.once('ready-to-show', () => {
    void win.show();
  });
  await win.loadURL(
    `data:text/html;charset=UTF-8,${encodeURIComponent(startupDocumentHtml(APP_NAME))}`,
  );
  logStartupTiming('startup-window-visible');
  return win;
}

async function createMainWindow(url: string): Promise<BrowserWindow> {
  const win = createWindow(false);
  win.once('ready-to-show', () => {
    void win.show();
  });
  await win.loadURL(url);
  return win;
}

function bindMainWindowCloseHandler(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    void gracefulShutdown();
  });
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
  ipcMain.handle(IPC.SCREEN_PING_GET, () => {
    const settings = readScreenPingSettings();
    return {
      supported: process.platform === 'win32',
      enabled: settings.enabled,
      cropWidth: settings.cropWidth,
      cropHeight: settings.cropHeight,
    };
  });
  ipcMain.handle(IPC.SCREEN_PING_SET, (_e, patch: unknown) => {
    if (!patch || typeof patch !== 'object') throw new Error('屏幕问号设置无效');
    const body = patch as { enabled?: unknown; cropWidth?: unknown; cropHeight?: unknown };
    const next: { enabled?: boolean; cropWidth?: number; cropHeight?: number } = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') throw new Error('屏幕问号开关无效');
      next.enabled = body.enabled;
    }
    if (body.cropWidth !== undefined) {
      if (typeof body.cropWidth !== 'number' || !Number.isFinite(body.cropWidth)) {
        throw new Error('截图宽度无效');
      }
      next.cropWidth = body.cropWidth;
    }
    if (body.cropHeight !== undefined) {
      if (typeof body.cropHeight !== 'number' || !Number.isFinite(body.cropHeight)) {
        throw new Error('截图高度无效');
      }
      next.cropHeight = body.cropHeight;
    }
    const saved = writeScreenPingSettings(next);
    if (typeof next.enabled === 'boolean') screenPing?.setEnabled(saved.enabled);
    return {
      supported: process.platform === 'win32',
      enabled: saved.enabled,
      cropWidth: saved.cropWidth,
      cropHeight: saved.cropHeight,
    };
  });

  ipcMain.handle(IPC.WORKSPACE_PICK, async () => {
    const ws = await pickWorkspaceInteractive();
    broadcastWorkspace(ws);
    return ws;
  });
  ipcMain.handle(IPC.WORKSPACE_GET, () => readWorkspace());

  ipcMain.handle(IPC.DATA_DIRECTORY_GET, () => resolveDataDirectory());
  ipcMain.handle(IPC.DATA_DIRECTORY_PICK, async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 iceCoder 数据文件夹',
      defaultPath: resolveDataDirectory(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
  ipcMain.handle(IPC.DATA_DIRECTORY_SET, (_e, dataDir: unknown) => {
    if (dataDir !== null && typeof dataDir !== 'string') {
      throw new Error('数据目录必须是绝对路径');
    }
    writeDataDirectory(dataDir);
    return resolveDataDirectory();
  });

  ipcMain.on(IPC.APP_OPEN_DATA_DIR, () => {
    void shell.openPath(resolveDataDirectory());
  });
  ipcMain.on(IPC.APP_DEVTOOLS, () => {
    mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });
  ipcMain.on(IPC.APP_QUIT, () => {
    void gracefulShutdown();
  });

  // 任务完成系统通知（渲染层仅在配置开启时发送）
  ipcMain.on(IPC.TASK_DONE_NOTIFY, (_e: Electron.IpcMainEvent, payload: unknown) => {
    const decision = resolveTaskDoneNotification(payload, mainWindow, APP_NAME);
    if (decision.skip) return; // 非法载荷 / R10 主窗在前台

    try {
      const notification = showTaskDoneSystemNotification({
        title: decision.title,
        body: decision.body,
      });
      // R9：点击通知 → 恢复并聚焦主窗
      notification.on('click', () => {
        showAndFocusMain();
        const sid = typeof decision.sessionId === 'string' ? decision.sessionId : '';
        if (sid && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.TASK_DONE_NOTIFY_CLICK, sid);
        }
      });
      notification.show();
    } catch (err) {
      writeConsole(process.stderr, `[main] 系统通知失败: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  });
}

function showAndFocusMain(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

/** 把主窗口拉到前台。浮层仍在上面，但是点击穿透，键盘会进到输入框。 */
function focusMainForPaste(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  mainWindow.setAlwaysOnTop(false);
  mainWindow.webContents.focus();
}

async function gracefulShutdown(): Promise<void> {
  if (isQuitting) return;
  isQuitting = true;

  try { screenPing?.stop(); } catch { /* ignore */ }
  screenPing = null;

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
  registerWindowChromeIpc();
  mainWindow = await createStartupWindow();
  logStartupTiming('server-bootstrap-start');

  // 1) 探测端口
  const port = await getAvailablePort(DEFAULT_HTTP_PORT, 50);
  logStartupTiming('port-selected');
  // 2) 启动 server 子进程
  const dataDir = resolveDataDirectory();
  const serverCwd = resolveServerCwd();
  const defaultWorkDir = readWorkspace() ?? serverCwd;
  serverHandle = await startServerProcess({
    port,
    cwd: serverCwd,
    env: {
      ...process.env,
      ICE_DATA_DIR: dataDir,
      ICE_MCP_CONFIG_PATH: path.join(dataDir, 'mcp.json'),
      ICE_DEFAULT_WORK_DIR: defaultWorkDir,
    },
  });
  logStartupTiming('server-ready');
  if (isQuitting) {
    await serverHandle.stop();
    serverHandle = null;
    return;
  }
  const url = `http://127.0.0.1:${port}`;
  screenPing = createScreenPingController({
    serverBaseUrl: url,
    onPasteShot(dataUrl) {
      focusMainForPaste();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send(IPC.SCREEN_PING_PASTE, dataUrl);
    },
  });
  registerIpcHandlers();

  // 3) 将已显示的加载窗口导航至主应用，避免服务启动期间白屏。
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = await createMainWindow(url);
  } else {
    await mainWindow.loadURL(url);
  }
  logStartupTiming('main-window-loaded');

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
    void createMainWindow(serverHandle.url).then((win) => {
      mainWindow = win;
    });
  } else {
    showAndFocusMain();
  }
});

app.whenReady().then(() => {
  logStartupTiming('electron-ready');
  configureWindowsNotificationIdentity(
    resolveDesktopAssetsDir(),
    path.join(__dirname, '..', 'scripts', 'ensure-notification-shortcut.ps1'),
  );
  // 启动窗口创建前就移除默认菜单，避免加载阶段出现 File/Edit 顶栏
  Menu.setApplicationMenu(null);
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
