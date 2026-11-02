/**
 * 框选截图的区域按整张桌面的物理像素计算，不收在单块屏幕里。
 * 每块屏幕只负责把同一块矩形画进自己的浮层，坐标可以是负数或超出本屏。
 */
import { physicalToLocal, type DisplayMap, type ScreenRect } from './geometry';

/** 小于这个物理像素的拖拽当成点击，不替换已经选好的区域。 */
export const SNIP_MIN_PX = 8;

export const SNIP_BAR_W = 148;
export const SNIP_BAR_H = 40;
const SNIP_BAR_PAD = 6;
const SNIP_BTN_W = 64;
const SNIP_BTN_GAP = 8;
const SNIP_DBL_MS = 400;

export type SnipEdge = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type SnipGesture = SnipEdge | 'move' | 'new';

export interface SnipSession {
  phase: 'armed' | 'drag' | 'hold' | 'move' | 'resize' | 'button' | 'chosen';
  rect: ScreenRect | null;
  anchorX: number;
  anchorY: number;
  origin: ScreenRect | null;
  gesture: SnipGesture | null;
  button: 'ok' | 'cancel' | null;
  lastClickUp: number;
}

export type SnipInput =
  | { kind: 'down' | 'move' | 'up'; x: number; y: number; now: number }
  | { kind: 'confirm' }
  | { kind: 'cancel' };

export interface SnipResult {
  state: SnipSession;
  paint: boolean;
  done: 'ok' | 'cancel' | null;
}

export function createSnipSession(): SnipSession {
  return {
    phase: 'armed',
    rect: null,
    anchorX: 0,
    anchorY: 0,
    origin: null,
    gesture: null,
    button: null,
    lastClickUp: -SNIP_DBL_MS,
  };
}

/** 把手势后的样子画出来：调整中的选区仍然带着完成按钮。 */
export function snipShowsChrome(phase: SnipSession['phase']): boolean {
  return phase === 'chosen' || phase === 'hold' || phase === 'button' || phase === 'move' || phase === 'resize';
}

export function unionPhysical(maps: readonly DisplayMap[]): ScreenRect | null {
  if (maps.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const map of maps) {
    left = Math.min(left, map.phys.x);
    top = Math.min(top, map.phys.y);
    right = Math.max(right, map.phys.x + map.phys.width);
    bottom = Math.max(bottom, map.phys.y + map.phys.height);
  }
  if (!Number.isFinite(left) || right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 整块物理矩形投影到某一块屏幕的浮层坐标。
 * 跨屏时起点可以落在这块屏幕外面，宽高仍按这块屏幕的缩放换算。
 */
export function physicalRectToLocal(
  rect: ScreenRect,
  map: DisplayMap,
): { x: number; y: number; w: number; h: number } {
  const scale = map.scale > 0 && Number.isFinite(map.scale) ? map.scale : 1;
  return {
    x: (rect.x - map.phys.x) / scale,
    y: (rect.y - map.phys.y) / scale,
    w: rect.width / scale,
    h: rect.height / scale,
  };
}

/**
 * 问号落在选区下沿中点，回答卡片就在选区旁边。
 * 贴着屏幕下沿时改落到选区上沿。上下都贴边时收到屏幕里面，避免回答画出屏幕。
 */
export function askAnchorNear(rect: ScreenRect, maps: readonly DisplayMap[]): { x: number; y: number } {
  const cx = rect.x + Math.max(rect.width, 1) / 2;
  const bounds = unionPhysical(maps);
  const bottom = rect.y + rect.height;
  if (!bounds) return { x: cx, y: bottom };
  const probeY = Math.min(Math.max(bottom, bounds.y), bounds.y + bounds.height - 1);
  const hit = physicalToLocal(Math.min(Math.max(cx, bounds.x), bounds.x + bounds.width - 1), probeY, maps);
  const map = hit ? maps.find((item) => item.id === hit.id) : undefined;
  const scale = map && map.scale > 0 ? map.scale : 1;
  const margin = 48 * scale;
  let y = bottom;
  if (y + 12 * scale > bounds.y + bounds.height) y = rect.y;
  const minY = bounds.y + margin;
  const maxY = bounds.y + bounds.height - margin;
  if (maxY > minY) y = Math.min(Math.max(y, minY), maxY);
  const x = Math.min(Math.max(cx, bounds.x), bounds.x + bounds.width - 1);
  return { x, y };
}

/** 完成按钮放在选区右下角所在的那块屏幕上。 */
export function snipChromeDisplay(rect: ScreenRect, maps: readonly DisplayMap[]): number | null {
  if (rect.width < 1 || rect.height < 1) return null;
  return physicalToLocal(rect.x + rect.width - 1, rect.y + rect.height - 1, maps)?.id ?? null;
}

/** 工具条在本屏浮层里的位置。和页面上的算法一致。 */
export function snipBarPlacement(
  local: { x: number; y: number; w: number; h: number },
  view: { width: number; height: number },
): { x: number; y: number } {
  const gap = 8;
  let top = local.y + local.h + gap;
  let left = local.x + local.w - SNIP_BAR_W;
  if (top + SNIP_BAR_H > view.height - 4) {
    top = local.y - SNIP_BAR_H - gap;
    if (local.y >= 28) top -= 22;
  }
  if (top < 4) top = 4;
  const maxLeft = Math.max(4, view.width - SNIP_BAR_W - 4);
  left = Math.min(Math.max(left, 4), maxLeft);
  return { x: left, y: top };
}

export function hitSnipButton(
  rect: ScreenRect,
  x: number,
  y: number,
  maps: readonly DisplayMap[],
): 'ok' | 'cancel' | null {
  const ownerId = snipChromeDisplay(rect, maps);
  if (ownerId == null) return null;
  const map = maps.find((item) => item.id === ownerId);
  const point = physicalToLocal(x, y, maps);
  if (!map || !point || point.id !== ownerId) return null;
  const bar = snipBarPlacement(physicalRectToLocal(rect, map), {
    width: map.dip.width,
    height: map.dip.height,
  });
  if (point.x < bar.x || point.y < bar.y || point.x >= bar.x + SNIP_BAR_W || point.y >= bar.y + SNIP_BAR_H) {
    return null;
  }
  const innerX = point.x - bar.x - SNIP_BAR_PAD;
  if (innerX >= 0 && innerX < SNIP_BTN_W) return 'ok';
  if (innerX >= SNIP_BTN_W + SNIP_BTN_GAP && innerX < SNIP_BTN_W * 2 + SNIP_BTN_GAP) return 'cancel';
  return null;
}

function hitRadius(x: number, y: number, maps: readonly DisplayMap[]): number {
  const point = physicalToLocal(x, y, maps);
  const map = point ? maps.find((item) => item.id === point.id) : undefined;
  const scale = map && map.scale > 0 ? map.scale : 1;
  return 8 * scale;
}

function hitEdge(rect: ScreenRect, x: number, y: number, maps: readonly DisplayMap[]): SnipEdge | null {
  const radius = hitRadius(x, y, maps);
  const corners: Array<[SnipEdge, number, number]> = [
    ['nw', rect.x, rect.y],
    ['ne', rect.x + rect.width, rect.y],
    ['se', rect.x + rect.width, rect.y + rect.height],
    ['sw', rect.x, rect.y + rect.height],
  ];
  for (const [edge, ex, ey] of corners) {
    if (Math.abs(x - ex) <= radius && Math.abs(y - ey) <= radius) return edge;
  }
  const edges: Array<[SnipEdge, number, number]> = [
    ['n', rect.x + rect.width / 2, rect.y],
    ['e', rect.x + rect.width, rect.y + rect.height / 2],
    ['s', rect.x + rect.width / 2, rect.y + rect.height],
    ['w', rect.x, rect.y + rect.height / 2],
  ];
  for (const [edge, ex, ey] of edges) {
    if (Math.abs(x - ex) <= radius && Math.abs(y - ey) <= radius) return edge;
  }
  return null;
}

function insideRect(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

function rectFromPoints(x0: number, y0: number, x1: number, y1: number): ScreenRect {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

function bigEnough(rect: ScreenRect | null): rect is ScreenRect {
  return !!rect && rect.width >= SNIP_MIN_PX && rect.height >= SNIP_MIN_PX;
}

function movedFar(ax: number, ay: number, x: number, y: number): boolean {
  return Math.hypot(x - ax, y - ay) >= SNIP_MIN_PX;
}

function boundsOrNull(maps: readonly DisplayMap[]): ScreenRect | null {
  return unionPhysical(maps);
}

function clampMove(origin: ScreenRect, dx: number, dy: number, bounds: ScreenRect | null): ScreenRect {
  let x = origin.x + dx;
  let y = origin.y + dy;
  if (!bounds) return { x, y, width: origin.width, height: origin.height };
  if (origin.width >= bounds.width) x = bounds.x;
  else x = Math.min(Math.max(x, bounds.x), bounds.x + bounds.width - origin.width);
  if (origin.height >= bounds.height) y = bounds.y;
  else y = Math.min(Math.max(y, bounds.y), bounds.y + bounds.height - origin.height);
  return { x, y, width: origin.width, height: origin.height };
}

function resizeRect(origin: ScreenRect, edge: SnipEdge, x: number, y: number): ScreenRect | null {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;
  const west = edge === 'nw' || edge === 'w' || edge === 'sw';
  const east = edge === 'ne' || edge === 'e' || edge === 'se';
  const north = edge === 'nw' || edge === 'n' || edge === 'ne';
  const south = edge === 'sw' || edge === 's' || edge === 'se';
  if (west) left = x;
  if (east) right = x;
  if (north) top = y;
  if (south) bottom = y;
  const rect = rectFromPoints(left, top, right, bottom);
  if (!bigEnough(rect)) return null;
  return rect;
}

function paint(state: SnipSession, done: SnipResult['done'] = null): SnipResult {
  return { state, paint: true, done };
}

function keep(state: SnipSession): SnipResult {
  return { state, paint: false, done: null };
}

export function reduceSnip(prev: SnipSession, input: SnipInput, maps: readonly DisplayMap[] = []): SnipResult {
  if (input.kind === 'cancel') return paint(createSnipSession(), 'cancel');
  if (input.kind === 'confirm') {
    if (!bigEnough(prev.rect)) return keep(prev);
    return paint(prev, 'ok');
  }

  const bounds = boundsOrNull(maps);
  if (input.kind === 'down') {
    if (bigEnough(prev.rect) && (prev.phase === 'chosen' || prev.phase === 'hold' || prev.phase === 'move' || prev.phase === 'resize')) {
      const button = hitSnipButton(prev.rect, input.x, input.y, maps);
      if (button) {
        return paint({ ...prev, phase: 'button', button, anchorX: input.x, anchorY: input.y });
      }
      if (input.now - prev.lastClickUp < SNIP_DBL_MS && insideRect(prev.rect, input.x, input.y)) {
        return paint(prev, 'ok');
      }
      const edge = hitEdge(prev.rect, input.x, input.y, maps);
      const gesture: SnipGesture = edge ?? (insideRect(prev.rect, input.x, input.y) ? 'move' : 'new');
      return paint({
        ...prev,
        phase: 'hold',
        anchorX: input.x,
        anchorY: input.y,
        origin: prev.rect,
        gesture,
        button: null,
      });
    }
    return paint({
      ...createSnipSession(),
      phase: 'drag',
      anchorX: input.x,
      anchorY: input.y,
      origin: { x: input.x, y: input.y, width: 0, height: 0 },
      rect: null,
      lastClickUp: prev.lastClickUp,
    });
  }

  if (input.kind === 'move') {
    if (prev.phase === 'button') return keep(prev);
    if (prev.phase === 'hold') {
      if (!movedFar(prev.anchorX, prev.anchorY, input.x, input.y) || !prev.origin || !prev.gesture) return keep(prev);
      if (prev.gesture === 'new') {
        return paint({
          ...prev,
          phase: 'drag',
          rect: rectFromPoints(prev.anchorX, prev.anchorY, input.x, input.y),
        });
      }
      if (prev.gesture === 'move') {
        return paint({
          ...prev,
          phase: 'move',
          rect: clampMove(prev.origin, input.x - prev.anchorX, input.y - prev.anchorY, bounds),
        });
      }
      const resized = resizeRect(prev.origin, prev.gesture, input.x, input.y);
      return paint({ ...prev, phase: 'resize', rect: resized ?? prev.rect });
    }
    if (prev.phase === 'drag') {
      return paint({ ...prev, rect: rectFromPoints(prev.anchorX, prev.anchorY, input.x, input.y) });
    }
    if (prev.phase === 'move' && prev.origin) {
      return paint({
        ...prev,
        rect: clampMove(prev.origin, input.x - prev.anchorX, input.y - prev.anchorY, bounds),
      });
    }
    if (prev.phase === 'resize' && prev.origin && prev.gesture && prev.gesture !== 'move' && prev.gesture !== 'new') {
      const resized = resizeRect(prev.origin, prev.gesture, input.x, input.y);
      return paint({ ...prev, rect: resized ?? prev.rect });
    }
    return keep(prev);
  }

  if (prev.phase === 'button') {
    const still = prev.rect ? hitSnipButton(prev.rect, input.x, input.y, maps) : null;
    if (still && still === prev.button && bigEnough(prev.rect)) {
      return paint({ ...prev, phase: 'chosen' }, still === 'ok' ? 'ok' : 'cancel');
    }
    return paint({ ...prev, phase: 'chosen', button: null });
  }
  if (prev.phase === 'hold' && movedFar(prev.anchorX, prev.anchorY, input.x, input.y) && prev.origin && prev.gesture) {
    const moved = reduceSnip(prev, { kind: 'move', x: input.x, y: input.y, now: input.now }, maps);
    return reduceSnip(moved.state, input, maps);
  }
  if (prev.phase === 'hold') {
    const inside = prev.rect ? insideRect(prev.rect, input.x, input.y) : false;
    return paint({
      ...prev,
      phase: 'chosen',
      gesture: null,
      lastClickUp: inside ? input.now : prev.lastClickUp,
    });
  }
  if (prev.phase === 'drag') {
    const rect = rectFromPoints(prev.anchorX, prev.anchorY, input.x, input.y);
    if (!bigEnough(rect)) return paint(createSnipSession());
    return paint({ ...createSnipSession(), phase: 'chosen', rect, lastClickUp: input.now }, 'ok');
  }
  if ((prev.phase === 'move' || prev.phase === 'resize') && bigEnough(prev.rect)) {
    const click = !movedFar(prev.anchorX, prev.anchorY, input.x, input.y);
    return paint({
      ...prev,
      phase: 'chosen',
      gesture: null,
      origin: null,
      lastClickUp: click ? input.now : prev.lastClickUp,
    });
  }
  return keep(prev);
}
