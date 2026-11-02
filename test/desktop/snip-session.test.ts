import { describe, expect, it } from 'vitest';
import type { DisplayMap } from '../../desktop/src/ping/geometry.js';
import {
  askAnchorNear,
  createSnipSession,
  hitSnipButton,
  physicalRectToLocal,
  reduceSnip,
  snipBarPlacement,
  snipChromeDisplay,
} from '../../desktop/src/ping/snip-session.js';

function screen(id: number, x: number, width: number, scale = 1): DisplayMap {
  return {
    id,
    dip: { x, y: 0, width: width / scale, height: 1080 / scale },
    phys: { x, y: 0, width, height: 1080 },
    scale,
  };
}

const maps = [screen(1, 0, 1920), screen(2, 1920, 1920)];

function drag(points: Array<{ x: number; y: number }>): ReturnType<typeof reduceSnip> {
  let result = reduceSnip(createSnipSession(), { kind: 'down', x: points[0]!.x, y: points[0]!.y, now: 0 }, maps);
  points.forEach((point, index) => {
    if (index === 0) return;
    const kind = index === points.length - 1 ? 'up' as const : 'move' as const;
    result = reduceSnip(result.state, { kind, x: point.x, y: point.y, now: index * 10 }, maps);
  });
  return result;
}

describe('跨屏幕框选', () => {
  it('从左屏拖到右屏松开后直接完成，矩形不被左屏右边缘截断', () => {
    const result = drag([
      { x: 1800, y: 100 },
      { x: 2300, y: 400 },
      { x: 2300, y: 400 },
    ]);
    expect(result.done).toBe('ok');
    expect(result.state.rect).toEqual({ x: 1800, y: 100, width: 500, height: 300 });
  });

  it('同一块矩形投影到两块屏幕，右屏的起点可以是负数', () => {
    const rect = { x: 1800, y: 100, width: 600, height: 200 };
    expect(physicalRectToLocal(rect, maps[0]!)).toEqual({ x: 1800, y: 100, w: 600, h: 200 });
    expect(physicalRectToLocal(rect, maps[1]!)).toEqual({ x: -120, y: 100, w: 600, h: 200 });
    expect(snipChromeDisplay(rect, maps)).toBe(2);
  });

  it('高分屏按自己的缩放投影，跨过来的宽度不会被截成左屏剩下的那一截', () => {
    const hidpi = screen(2, 1920, 1920, 2);
    expect(physicalRectToLocal({ x: 1800, y: 100, width: 600, height: 200 }, hidpi)).toEqual({
      x: -60,
      y: 50,
      w: 300,
      h: 100,
    });
  });

  it('中间没有移动事件时，松开仍按起点和终点跨屏成矩形', () => {
    let state = createSnipSession();
    state = reduceSnip(state, { kind: 'down', x: 1700, y: 80, now: 0 }, maps).state;
    const up = reduceSnip(state, { kind: 'up', x: 2500, y: 420, now: 40 }, maps);
    expect(up.done).toBe('ok');
    expect(up.state.rect).toEqual({ x: 1700, y: 80, width: 800, height: 340 });
  });

  it('点一下不会清掉已经跨屏的选区，拖开以后才会换成新区域', () => {
    const chosen = drag([
      { x: 1800, y: 100 },
      { x: 2300, y: 400 },
      { x: 2300, y: 400 },
    ]).state;
    const down = reduceSnip(chosen, { kind: 'down', x: 100, y: 80, now: 1000 }, maps);
    expect(down.state.phase).toBe('hold');
    expect(down.state.rect).toEqual(chosen.rect);
    const up = reduceSnip(down.state, { kind: 'up', x: 102, y: 80, now: 1020 }, maps);
    expect(up.state.phase).toBe('chosen');
    expect(up.state.rect).toEqual(chosen.rect);
    const again = reduceSnip(up.state, { kind: 'down', x: 100, y: 80, now: 5000 }, maps);
    const moved = reduceSnip(again.state, { kind: 'move', x: 2100, y: 80, now: 5060 }, maps);
    expect(moved.state.phase).toBe('drag');
    expect(moved.state.rect).toMatchObject({ x: 100, width: 2000 });
  });

  it('问号落在选区下沿，贴着屏幕底边时改到上沿', () => {
    const rect = { x: 1800, y: 100, width: 400, height: 200 };
    expect(askAnchorNear(rect, maps)).toEqual({ x: 2000, y: 300 });
    expect(askAnchorNear({ x: 100, y: 1000, width: 200, height: 80 }, maps)).toEqual({ x: 200, y: 1000 });
    const full = askAnchorNear({ x: 0, y: 0, width: 1920, height: 1080 }, maps);
    expect(full.x).toBe(960);
    expect(full.y).toBeGreaterThanOrEqual(48);
    expect(full.y).toBeLessThan(1080);
  });

  it('完成按钮落在选区右下角所在的屏幕上', () => {
    const rect = { x: 1800, y: 200, width: 500, height: 300 };
    const local = physicalRectToLocal(rect, maps[1]!);
    const bar = snipBarPlacement(local, { width: maps[1]!.dip.width, height: maps[1]!.dip.height });
    const physX = maps[1]!.phys.x + bar.x + 6 + 32;
    const physY = maps[1]!.phys.y + bar.y + 20;
    expect(hitSnipButton(rect, physX, physY, maps)).toBe('ok');
    const chosen = drag([
      { x: 1800, y: 200 },
      { x: 2300, y: 500 },
      { x: 2300, y: 500 },
    ]).state;
    const press = reduceSnip(chosen, { kind: 'down', x: physX, y: physY, now: 9000 }, maps);
    expect(press.state.phase).toBe('button');
    expect(press.state.rect).toEqual(rect);
    const release = reduceSnip(press.state, { kind: 'up', x: physX, y: physY, now: 9040 }, maps);
    expect(release.done).toBe('ok');
  });
});
