/**
 * 问号轮盘几何。扇区从正上方起顺时针 8 等分，问号在正左（与常见信号轮盘同一侧）。
 * 手势阈值与中心取消半径参照 lolPing 的轮盘规格（MIT），图形是自绘的。
 */

/** 落点周围截图边长（物理像素）。用户可在设置里改。 */
export const ASK_CROP_PX = 200;
export const ASK_CROP_MIN = 80;
export const ASK_CROP_MAX = 800;

/** 把输入收成合法边长。空的或不是数字时用默认值。 */
export function normalizeCropPx(value: unknown, fallback = ASK_CROP_PX): number {
  const raw = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(ASK_CROP_MAX, Math.max(ASK_CROP_MIN, Math.round(raw)));
}

/** 把物理像素边长换成这块屏幕上的 CSS 像素，线和截图对齐。 */
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
 * 以落点为中心裁 200×200。贴边时整块挪进屏幕，锚点跟着偏，避免裁出屏幕外。
 */
export function cropAroundPoint(
  pointX: number,
  pointY: number,
  screen: { left: number; top: number; width: number; height: number },
  size = ASK_CROP_PX,
): CropRect {
  const maxW = Math.max(1, Math.floor(screen.width));
  const maxH = Math.max(1, Math.floor(screen.height));
  const width = Math.min(size, maxW);
  const height = Math.min(size, maxH);
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
