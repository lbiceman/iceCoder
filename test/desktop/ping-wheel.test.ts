import { describe, expect, it } from 'vitest';
import { QUESTION_SLICE, cropAroundPoint, cropCssSize, normalizeCropPx, physicalToLocal, wheelSlice } from '../../desktop/src/ping/geometry.js';
import { INITIAL_GESTURE, reduceGesture } from '../../desktop/src/ping/gesture.js';

describe('问号轮盘几何', () => {
  it('八个方向对上扇区，正左是问号', () => {
    expect(wheelSlice(0, -120)).toBe(0);
    expect(wheelSlice(120, -120)).toBe(1);
    expect(wheelSlice(120, 0)).toBe(2);
    expect(wheelSlice(120, 120)).toBe(3);
    expect(wheelSlice(0, 120)).toBe(4);
    expect(wheelSlice(-120, 120)).toBe(5);
    expect(wheelSlice(-120, 0)).toBe(QUESTION_SLICE);
    expect(wheelSlice(-120, -120)).toBe(7);
  });

  it('中心圆内松手不算选中', () => {
    expect(wheelSlice(0, 0)).toBeNull();
    expect(wheelSlice(40, -20)).toBeNull();
    expect(wheelSlice(0, -86)).not.toBeNull();
  });

  it('贴边时把 200px 裁切挪进屏幕，锚点跟着偏', () => {
    const crop = cropAroundPoint(10, 20, { left: 0, top: 0, width: 1920, height: 1080 });
    expect(crop).toMatchObject({ x: 0, y: 0, width: 200, height: 200, anchorX: 10, anchorY: 20 });
  });

  it('高分屏上线框按缩放换成 CSS 像素', () => {
    expect(cropCssSize(1)).toBe(200);
    expect(cropCssSize(2)).toBe(100);
    expect(cropCssSize(1.5)).toBe(133);
    expect(cropCssSize(2, 400)).toBe(200);
  });

  it('宽和高可以不一样', () => {
    const crop = cropAroundPoint(500, 400, { left: 0, top: 0, width: 1920, height: 1080 }, 400, 120);
    expect(crop).toMatchObject({ x: 300, y: 340, width: 400, height: 120, anchorX: 200, anchorY: 60 });
  });

  it('截图边长收进 80 到 800', () => {
    expect(normalizeCropPx('')).toBe(200);
    expect(normalizeCropPx('320')).toBe(320);
    expect(normalizeCropPx(10)).toBe(80);
    expect(normalizeCropPx(5000)).toBe(800);
  });

  it('物理像素换到浮层坐标时不取整，副屏和缩放都对着屏幕原点', () => {
    const primary = {
      id: 1,
      dip: { x: 0, y: 0, width: 1920, height: 1080 },
      phys: { x: 0, y: 0, width: 1920, height: 1080 },
      scale: 1,
    };
    const hidpi = {
      id: 2,
      dip: { x: 1920, y: 0, width: 1920, height: 1080 },
      phys: { x: 3840, y: 0, width: 3840, height: 2160 },
      scale: 2,
    };
    expect(physicalToLocal(100.5, 40.25, [primary, hidpi])).toEqual({ id: 1, x: 100.5, y: 40.25 });
    expect(physicalToLocal(4040, 200, [primary, hidpi])).toEqual({ id: 2, x: 100, y: 100 });
  });

  it('副屏负坐标仍然以落点为中心', () => {
    const crop = cropAroundPoint(-500, 400, { left: -1920, top: 0, width: 3840, height: 1080 });
    expect(crop.x).toBe(-600);
    expect(crop.y).toBe(300);
    expect(crop.anchorX).toBe(100);
    expect(crop.anchorY).toBe(100);
  });
});

describe('问号轮盘手势', () => {
  it('没按住 Ctrl 时左键不打开轮盘', () => {
    const down = reduceGesture(INITIAL_GESTURE, {
      kind: 'mouseDown', x: 10, y: 20, trigger: false, injected: false,
    });
    expect(down.swallow).toBe(false);
    expect(down.state.phase).toBe('idle');
  });

  it('按住 Ctrl 再按左键，没拖开就回放这次点击', () => {
    const down = reduceGesture(INITIAL_GESTURE, {
      kind: 'mouseDown', x: 10, y: 20, trigger: true, injected: false,
    });
    expect(down.swallow).toBe(true);
    expect(down.state.phase).toBe('pending');
    const nudge = reduceGesture(down.state, { kind: 'mouseMove', x: 12, y: 21, injected: false });
    expect(nudge.effect.type).toBe('none');
    const up = reduceGesture(nudge.state, { kind: 'mouseUp', x: 12, y: 21, injected: false });
    expect(up.swallow).toBe(true);
    expect(up.replay).toEqual({ x: 10, y: 20 });
    expect(up.state.phase).toBe('idle');
  });

  it('按住 Ctrl 并拖动左键才打开轮盘，松开左键落在问号上', () => {
    const down = reduceGesture(INITIAL_GESTURE, {
      kind: 'mouseDown', x: 400, y: 300, trigger: true, injected: false,
    });
    const open = reduceGesture(down.state, { kind: 'mouseMove', x: 280, y: 300, injected: false });
    expect(open.effect).toMatchObject({ type: 'open', originX: 400, originY: 300, x: 280, y: 300 });
    const moved = reduceGesture(open.state, { kind: 'mouseMove', x: 250, y: 300, injected: false });
    expect(moved.effect.type).toBe('move');
    const up = reduceGesture(moved.state, { kind: 'mouseUp', x: 250, y: 300, injected: false });
    expect(up.effect).toMatchObject({ type: 'release', originX: 400, originY: 300, x: 250, y: 300 });
    expect(up.swallow).toBe(true);
    expect(wheelSlice(250 - 400, 0)).toBe(QUESTION_SLICE);
  });

  it('只按住 Ctrl 移动鼠标不会进入轮盘', () => {
    const move = reduceGesture(INITIAL_GESTURE, { kind: 'mouseMove', x: 40, y: 0, injected: false });
    expect(move.effect.type).toBe('none');
    expect(move.state.phase).toBe('idle');
  });

  it('右键和 Esc 取消轮盘，Esc 在有回答时关掉回答', () => {
    const down = reduceGesture(INITIAL_GESTURE, {
      kind: 'mouseDown', x: 0, y: 0, trigger: true, injected: false,
    });
    const open = reduceGesture(down.state, { kind: 'mouseMove', x: 40, y: 0, injected: false });
    const right = reduceGesture(open.state, { kind: 'rightDown', injected: false });
    expect(right.effect.type).toBe('cancel');
    expect(right.swallow).toBe(true);
    const escMarker = reduceGesture(INITIAL_GESTURE, { kind: 'escape', markerOpen: true });
    expect(escMarker.effect.type).toBe('dismiss');
    expect(escMarker.swallow).toBe(true);
  });
});
