/**
 * 无边框窗口在 Windows 上会把缩放热区伸进客户区大约 8px，盖住贴边的滚动条。
 * Chrome / VS Code 只保留贴边的一窄条，再往里的命中还给页面。
 */

export const HTCLIENT = 1;
export const HTLEFT = 10;
export const HTRIGHT = 11;
export const HTTOP = 12;
export const HTTOPLEFT = 13;
export const HTTOPRIGHT = 14;
export const HTBOTTOM = 15;
export const HTBOTTOMLEFT = 16;
export const HTBOTTOMRIGHT = 17;

export interface WindowRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 只保留贴边 edge 像素内的缩放命中，再往里的改回客户区。 */
export function narrowResizeHit(
  hit: number,
  x: number,
  y: number,
  rect: WindowRect,
  edge: number,
): number {
  if (hit < HTLEFT || hit > HTBOTTOMRIGHT) return hit;
  const band = Math.max(1, edge);
  const onLeft = x - rect.left < band;
  const onRight = rect.right - x <= band;
  const onTop = y - rect.top < band;
  const onBottom = rect.bottom - y <= band;
  const keep = (hit === HTLEFT && onLeft)
    || (hit === HTRIGHT && onRight)
    || (hit === HTTOP && onTop)
    || (hit === HTBOTTOM && onBottom)
    || (hit === HTTOPLEFT && onTop && onLeft)
    || (hit === HTTOPRIGHT && onTop && onRight)
    || (hit === HTBOTTOMLEFT && onBottom && onLeft)
    || (hit === HTBOTTOMRIGHT && onBottom && onRight);
  return keep ? hit : HTCLIENT;
}

/** WM_NCHITTEST 的 lParam：低 16 位是屏幕 x，高 16 位是屏幕 y，都是有符号短整数。 */
export function ncHitPoint(lParam: unknown): { x: number; y: number } {
  const bits = (typeof lParam === 'bigint' ? lParam : BigInt(Number(lParam) || 0)) & 0xffffffffn;
  return {
    x: Number(BigInt.asIntN(16, bits)),
    y: Number(BigInt.asIntN(16, bits >> 16n)),
  };
}
