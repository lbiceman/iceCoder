/**
 * pet-window.ts — 桌面透明悬浮冰豆 BrowserWindow
 */
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { readPetFloatingPosition } from './paths';
import { IPC } from './constants';

const PET_SIZE = 120;

export interface PetWindowOptions {
  /** 初始位置（屏幕坐标）；不传则从持久化或默认右上角。 */
  initialPosition?: { x: number; y: number };
}

export function createPetFloatingWindow(opts: PetWindowOptions = {}): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const saved = readPetFloatingPosition();
  const defaultX = workArea.x + workArea.width - PET_SIZE - 40;
  const defaultY = workArea.y + workArea.height - PET_SIZE - 40;
  const x = opts.initialPosition?.x ?? saved?.x ?? defaultX;
  const y = opts.initialPosition?.y ?? saved?.y ?? defaultY;

  const win = new BrowserWindow({
    width: PET_SIZE,
    height: PET_SIZE,
    x,
    y,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false, // 我们自己用 -webkit-app-region: drag 处理拖动
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 加载悬浮冰豆专用页（pet-renderer 在 build 时复制到 dist 同级）
  const htmlPath = path.join(__dirname, '..', 'pet-renderer', 'pet-floating.html');
  void win.loadFile(htmlPath);

  // 防焦点抢占
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  return win;
}
