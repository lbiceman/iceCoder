/**
 * tray.ts — 系统托盘
 */
import { Tray, Menu, nativeImage, BrowserWindow } from 'electron';
import path from 'node:path';

export interface TrayCallbacks {
  showMain: () => void;
  quit: () => void;
}

function resolveTrayIcon(): Electron.NativeImage {
  const assetsDir = path.join(__dirname, '..', 'assets');
  const candidates =
    process.platform === 'win32'
      ? ['tray-icon.png', 'icon.ico', 'icon.png']
      : ['tray-icon.png', 'icon.png', 'icon.ico'];
  for (const name of candidates) {
    const image = nativeImage.createFromPath(path.join(assetsDir, name));
    if (!image.isEmpty()) {
      const traySize = process.platform === 'win32' ? 16 : 22;
      const { width } = image.getSize();
      return width === traySize
        ? image
        : image.resize({ width: traySize, height: traySize, quality: 'best' });
    }
  }
  return nativeImage.createEmpty();
}

export function buildTray(
  mainWindow: BrowserWindow,
  cb: TrayCallbacks,
): Tray {
  const tray = new Tray(resolveTrayIcon());
  tray.setToolTip('iceCoder');

  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => cb.showMain(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => cb.quit(),
    },
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => cb.showMain());
  tray.on('double-click', () => cb.showMain());

  return tray;
}
