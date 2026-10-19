/**
 * 问号轮盘几何。扇区从正上方起顺时针 8 等分，问号在正左（与常见信号轮盘同一侧）。
 * 手势阈值、中心取消半径，以及物理像素到浮层坐标的换算，参照 lolPing（MIT）。图形是自绘的。
 */

/** 落点周围截图的默认宽和高（物理像素）。用户可在设置里分开改。 */
export const ASK_CROP_PX = 200;
export const ASK_CROP_MIN = 80;
export const ASK_CROP_MAX = 800;

/** 把输入收成合法的宽或高。空的或不是数字时用默认值。 */
export function normalizeCropPx(value: unknown, fallback = ASK_CROP_PX): number {
  const raw = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(ASK_CROP_MAX, Math.max(ASK_CROP_MIN, Math.round(raw)));
}

/** 把物理像素换成这块屏幕上的 CSS 像素，线和截图对齐。 */
export function cropCssSize(scaleFactor: number, physical = ASK_CROP_PX): number {
  const scale = scaleFactor > 0 && Number.isFinite(scaleFactor) ? scaleFactor : 1;
  return Math.max(1, Math.round(physical / scale));
}

/** 中心圆半径。指针停在这里松手等于取消。 */
export const WHEEL_CENTER_RADIUS = 86;

export const WHEEL_SLICE_COUNT = 8;

/** 正左扇区。 */
export const QUESTION_SLICE = 6;

/** 按住触发键后，移动超过这个距离才打开轮盘（物理像素）。 */
export const DRAG_THRESHOLD_PX = 8;

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 问号落点在裁切图内的像素。 */
  anchorX: number;
  anchorY: number;
}

/**
 * 以落点为中心裁一块矩形。贴边时整块挪进屏幕，锚点跟着偏，避免裁出屏幕外。
 * 只传 width 时高和宽相同。
 */
export function cropAroundPoint(
  pointX: number,
  pointY: number,
  screen: { left: number; top: number; width: number; height: number },
  widthPx = ASK_CROP_PX,
  heightPx?: number,
): CropRect {
  const wantedW = widthPx > 0 && Number.isFinite(widthPx) ? widthPx : ASK_CROP_PX;
  const wantedH = heightPx != null && heightPx > 0 && Number.isFinite(heightPx) ? heightPx : wantedW;
  const maxW = Math.max(1, Math.floor(screen.width));
  const maxH = Math.max(1, Math.floor(screen.height));
  const width = Math.min(Math.max(1, wantedW), maxW);
  const height = Math.min(Math.max(1, wantedH), maxH);
  const minX = screen.left;
  const minY = screen.top;
  const maxX = screen.left + maxW - width;
  const maxY = screen.top + maxH - height;
  const x = Math.min(Math.max(Math.round(pointX - width / 2), minX), maxX);
  const y = Math.min(Math.max(Math.round(pointY - height / 2), minY), maxY);
  return {
    x,
    y,
    width,
    height,
    anchorX: Math.round(pointX - x),
    anchorY: Math.round(pointY - y),
  };
}

/**
 * 相对轮盘中心的位移落在哪个扇区。
 * 屏幕坐标 y 向下。正上为 0，顺时针。中心圆内返回 null。
 * 角度算法与 lolPing 的 pickSlice 一致。
 */
export function wheelSlice(
  dx: number,
  dy: number,
  center = WHEEL_CENTER_RADIUS,
): number | null {
  if (Math.hypot(dx, dy) < center) return null;
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 22.5 + 360) % 360;
  return Math.floor(deg / 45) % WHEEL_SLICE_COUNT;
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一块屏幕：Electron 用 DIP，钩子报的是物理像素。换算方式和 lolPing 的 DisplayMap 一致。 */
export interface DisplayMap {
  id: number;
  dip: ScreenRect;
  phys: ScreenRect;
  scale: number;
}

function contains(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function distSq(rect: ScreenRect, x: number, y: number): number {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width - 1));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height - 1));
  return dx * dx + dy * dy;
}

function displayAtPhysical(x: number, y: number, maps: readonly DisplayMap[]): DisplayMap | null {
  if (maps.length === 0) return null;
  return maps.find((map) => contains(map.phys, x, y))
    ?? maps.reduce((best, map) => (distSq(map.phys, x, y) < distSq(best.phys, x, y) ? map : best));
}

/**
 * 物理像素落到这块屏幕浮层里的 CSS 坐标。
 * 不取整：取整会在落下之后和窗口原点差出一截，标记就会往旁边挪。
 */
export function physicalToLocal(
  x: number,
  y: number,
  maps: readonly DisplayMap[],
): { id: number; x: number; y: number } | null {
  const display = displayAtPhysical(x, y, maps);
  if (!display) return null;
  const scale = display.scale > 0 && Number.isFinite(display.scale) ? display.scale : 1;
  const dipX = display.dip.x + (x - display.phys.x) / scale;
  const dipY = display.dip.y + (y - display.phys.y) / scale;
  return {
    id: display.id,
    x: dipX - display.dip.x,
    y: dipY - display.dip.y,
  };
}
