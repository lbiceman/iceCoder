/**
 * 按住 Ctrl，再按住左键拖动才打开轮盘。松在扇区上落子，松在中心则取消。
 * 没拖过阈值的 Ctrl+点击会原样回放，复制粘贴这类快捷键不受影响。
 */

import { DRAG_THRESHOLD_PX } from './geometry';

export type GesturePhase = 'idle' | 'pending' | 'wheel';

export interface GestureSnapshot {
  phase: GesturePhase;
  originX: number;
  originY: number;
  x: number;
  y: number;
  ignoreNextUp: boolean;
  ignoreNextRightUp: boolean;
}

export const INITIAL_GESTURE: GestureSnapshot = {
  phase: 'idle',
  originX: 0,
  originY: 0,
  x: 0,
  y: 0,
  ignoreNextUp: false,
  ignoreNextRightUp: false,
};

export type GestureInput =
  | { kind: 'mouseDown'; x: number; y: number; trigger: boolean; injected: boolean }
  | { kind: 'mouseMove'; x: number; y: number; injected: boolean }
  | { kind: 'mouseUp'; x: number; y: number; injected: boolean }
  | { kind: 'triggerUp' }
  | { kind: 'otherKey' }
  | { kind: 'rightDown'; injected: boolean }
  | { kind: 'rightUp'; injected: boolean }
  | { kind: 'escape'; markerOpen: boolean }
  | { kind: 'abort' };

export type GestureEffect =
  | { type: 'none' }
  | { type: 'open'; originX: number; originY: number; x: number; y: number }
  | { type: 'move'; originX: number; originY: number; x: number; y: number }
  | { type: 'release'; originX: number; originY: number; x: number; y: number }
  | { type: 'cancel' }
  | { type: 'dismiss' };

export interface GestureResult {
  state: GestureSnapshot;
  swallow: boolean;
  replay: { x: number; y: number } | null;
  effect: GestureEffect;
}

function idle(extra: Partial<GestureSnapshot> = {}): GestureSnapshot {
  return { ...INITIAL_GESTURE, ...extra };
}

function out(
  state: GestureSnapshot,
  effect: GestureEffect,
  extra: Partial<Pick<GestureResult, 'swallow' | 'replay'>> = {},
): GestureResult {
  return {
    state,
    swallow: extra.swallow ?? false,
    replay: extra.replay ?? null,
    effect,
  };
}

function pass(state: GestureSnapshot): GestureResult {
  return out(state, { type: 'none' });
}

export function reduceGesture(prev: GestureSnapshot, input: GestureInput): GestureResult {
  switch (input.kind) {
    case 'mouseDown': {
      if (input.injected || !input.trigger || prev.phase !== 'idle') return pass(prev);
      return out({
        ...prev,
        phase: 'pending',
        originX: input.x,
        originY: input.y,
        x: input.x,
        y: input.y,
      }, { type: 'none' }, { swallow: true });
    }
    case 'mouseMove': {
      if (input.injected) return pass(prev);
      if (prev.phase === 'pending') {
        const moved = Math.hypot(input.x - prev.originX, input.y - prev.originY);
        if (moved < DRAG_THRESHOLD_PX) {
          return out({ ...prev, x: input.x, y: input.y }, { type: 'none' });
        }
        return out(
          { ...prev, phase: 'wheel', x: input.x, y: input.y },
          { type: 'open', originX: prev.originX, originY: prev.originY, x: input.x, y: input.y },
        );
      }
      if (prev.phase === 'wheel') {
        return out(
          { ...prev, x: input.x, y: input.y },
          { type: 'move', originX: prev.originX, originY: prev.originY, x: input.x, y: input.y },
        );
      }
      return pass(prev);
    }
    case 'mouseUp': {
      if (input.injected) return pass(prev);
      if (prev.ignoreNextUp) return out(idle(), { type: 'none' }, { swallow: true });
      if (prev.phase === 'pending') {
        return out(idle(), { type: 'none' }, { swallow: true, replay: { x: prev.originX, y: prev.originY } });
      }
      if (prev.phase === 'wheel') {
        return out(idle(), {
          type: 'release',
          originX: prev.originX,
          originY: prev.originY,
          x: input.x,
          y: input.y,
        }, { swallow: true });
      }
      return pass(prev);
    }
    case 'triggerUp': {
      if (prev.phase === 'pending') {
        return out(
          idle({ ignoreNextUp: true }),
          { type: 'cancel' },
          { replay: { x: prev.originX, y: prev.originY } },
        );
      }
      return pass(prev);
    }
    case 'otherKey': {
      if (prev.phase === 'pending') {
        return out(
          idle({ ignoreNextUp: true }),
          { type: 'cancel' },
          { replay: { x: prev.originX, y: prev.originY } },
        );
      }
      if (prev.phase === 'wheel') {
        return out(idle({ ignoreNextUp: true }), { type: 'cancel' });
      }
      return pass(prev);
    }
    case 'rightDown': {
      if (input.injected || prev.phase !== 'wheel') return pass(prev);
      return out(idle({ ignoreNextRightUp: true, ignoreNextUp: true }), { type: 'cancel' }, { swallow: true });
    }
    case 'rightUp': {
      if (input.injected || !prev.ignoreNextRightUp) return pass(prev);
      return out(idle({ ignoreNextUp: prev.ignoreNextUp }), { type: 'none' }, { swallow: true });
    }
    case 'escape': {
      if (prev.phase === 'wheel') {
        return out(idle({ ignoreNextUp: true }), { type: 'cancel' }, { swallow: true });
      }
      if (prev.phase === 'pending') {
        return out(
          idle({ ignoreNextUp: true }),
          { type: 'cancel' },
          { swallow: true, replay: { x: prev.originX, y: prev.originY } },
        );
      }
      if (input.markerOpen) return out(prev, { type: 'dismiss' }, { swallow: true });
      return pass(prev);
    }
    case 'abort': {
      if (prev.phase === 'idle') return pass(prev);
      return out(idle({ ignoreNextUp: true }), { type: 'cancel' });
    }
    default:
      return pass(prev);
  }
}
