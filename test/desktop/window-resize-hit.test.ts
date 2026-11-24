import { describe, expect, it } from 'vitest';
import {
  HTBOTTOM,
  HTBOTTOMRIGHT,
  HTCLIENT,
  HTRIGHT,
  HTTOP,
  narrowResizeHit,
  ncHitPoint,
} from '../../desktop/src/window-resize-hit.js';

const rect = { left: 100, top: 50, right: 500, bottom: 400 };

describe('narrowResizeHit', () => {
  it('贴右边 2px 内仍是缩放，滚动条所在的更内侧还给页面', () => {
    expect(narrowResizeHit(HTRIGHT, 499, 200, rect, 2)).toBe(HTRIGHT);
    expect(narrowResizeHit(HTRIGHT, 494, 200, rect, 2)).toBe(HTCLIENT);
  });

  it('右下角只有两条边都贴着才保留，滚动条下端不再整块变成拉窗口', () => {
    expect(narrowResizeHit(HTBOTTOMRIGHT, 499, 399, rect, 2)).toBe(HTBOTTOMRIGHT);
    expect(narrowResizeHit(HTBOTTOMRIGHT, 490, 390, rect, 2)).toBe(HTCLIENT);
  });

  it('标题栏拖动和客户区命中不动，贴着顶边才缩放', () => {
    expect(narrowResizeHit(2, 200, 60, rect, 2)).toBe(2);
    expect(narrowResizeHit(HTCLIENT, 200, 200, rect, 2)).toBe(HTCLIENT);
    expect(narrowResizeHit(HTTOP, 200, 51, rect, 2)).toBe(HTTOP);
    expect(narrowResizeHit(HTTOP, 200, 80, rect, 2)).toBe(HTCLIENT);
    expect(narrowResizeHit(HTBOTTOM, 200, 399, rect, 2)).toBe(HTBOTTOM);
  });

  it('解析 WM_NCHITTEST 的屏幕坐标，包含负数', () => {
    expect(ncHitPoint((20 << 16) | 100)).toEqual({ x: 100, y: 20 });
    expect(ncHitPoint(0xfffe0064)).toEqual({ x: 100, y: -2 });
  });
});