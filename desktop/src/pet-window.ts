/**
 * pet-window.ts — 桌面透明悬浮冰豆 BrowserWindow
 */
import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { readPetFloatingPosition } from './paths';

/** 与 chat.css 气泡 max-width、session-pet.js PET_SIZE 对齐 */
const PET_CANVAS = 96;
const PET_CONTENT_WIDTH = 280;
const PET_BUBBLE_SLOT = 52;
const PET_FOOT_SLOT = 36;
const PET_PAD_X = 16;
const PET_PAD_Y = 10;
export const PET_FLOATING_WIDTH = PET_CONTENT_WIDTH + PET_PAD_X * 2;
export const PET_FLOATING_HEIGHT = PET_PAD_Y + PET_BUBBLE_SLOT + PET_CANVAS + PET_FOOT_SLOT + PET_PAD_Y;
/** 默认距工作区右边缘的内边距 */
const DEFAULT_MARGIN_RIGHT = 200;

export function defaultFloatingPosition(workArea: Electron.Rectangle): { x: number; y: number } {
  return {
    x: workArea.x + workArea.width - PET_FLOATING_WIDTH - DEFAULT_MARGIN_RIGHT,
    y: workArea.y + Math.round((workArea.height - PET_FLOATING_HEIGHT) / 2),
  };
}

export function clampFloatingPosition(
  x: number,
  y: number,
  workArea: Electron.Rectangle,
): { x: number; y: number } {
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - PET_FLOATING_WIDTH;
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - PET_FLOATING_HEIGHT;
  return {
    x: Math.min(Math.max(Math.round(x), minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(Math.round(y), minY), Math.max(minY, maxY)),
  };
}

function isPositionVisibleInWorkArea(
  x: number,
  y: number,
  workArea: Electron.Rectangle,
): boolean {
  return (
    x >= workArea.x &&
    y >= workArea.y &&
    x + PET_FLOATING_WIDTH <= workArea.x + workArea.width &&
    y + PET_FLOATING_HEIGHT <= workArea.y + workArea.height
  );
}

/** 解析悬浮窗坐标：无缓存 / 窗口尺寸变更 / 越界时回退到默认位。 */
export function resolveFloatingPosition(workArea: Electron.Rectangle): { x: number; y: number } {
  const fallback = defaultFloatingPosition(workArea);
  const saved = readPetFloatingPosition();
  if (!saved) return clampFloatingPosition(fallback.x, fallback.y, workArea);

  const sizeMatches =
    saved.w === PET_FLOATING_WIDTH && saved.h === PET_FLOATING_HEIGHT;
  if (!sizeMatches || !isPositionVisibleInWorkArea(saved.x, saved.y, workArea)) {
    return clampFloatingPosition(fallback.x, fallback.y, workArea);
  }

  return clampFloatingPosition(saved.x, saved.y, workArea);
}

export function applyFloatingWindowPosition(win: BrowserWindow): void {
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const { x, y } = resolveFloatingPosition(display.workArea);
  win.setPosition(x, y);
}

export interface PetWindowOptions {
  /** iceCoder HTTP 基址，如 http://127.0.0.1:1024 */
  serverBaseUrl: string;
  /** 初始位置（屏幕坐标）；不传则从持久化或默认（右侧约 200px、垂直居中）。 */
  initialPosition?: { x: number; y: number };
}

export function createPetFloatingWindow(opts: PetWindowOptions): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const resolved = opts.initialPosition
    ? clampFloatingPosition(opts.initialPosition.x, opts.initialPosition.y, workArea)
    : resolveFloatingPosition(workArea);

  const win = new BrowserWindow({
    width: PET_FLOATING_WIDTH,
    height: PET_FLOATING_HEIGHT,
    x: resolved.x,
    y: resolved.y,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
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

  const base = opts.serverBaseUrl.replace(/\/$/, '');
  void win.loadURL(`${base}/pet-floating.html`);

  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  return win;
}
