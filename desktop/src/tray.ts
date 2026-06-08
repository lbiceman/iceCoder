/**
 * tray.ts — 系统托盘
 */
import { Tray, Menu, app, nativeImage, BrowserWindow } from 'electron';
import path from 'node:path';
import { IPC } from './constants';

export interface TrayCallbacks {
  showMain: () => void;
  quit: () => void;
}

export function buildTray(
  mainWindow: BrowserWindow,
  cb: TrayCallbacks,
): Tray {
  // 占位图标：1x1 透明 PNG（无品牌资源时不报错）
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    image = nativeImage.createEmpty();
  }
  const tray = new Tray(image);
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
