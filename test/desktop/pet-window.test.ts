import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setStubUserData } from './electron-stub.js';

import {
  PET_FLOATING_WIDTH,
  PET_FLOATING_HEIGHT,
  defaultFloatingPosition,
  clampFloatingPosition,
  resolveFloatingPosition,
} from '../../desktop/src/pet-window.js';

const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };

describe('pet-window 几何逻辑（纯函数）', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'pet-window-'));
    setStubUserData(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('defaultFloatingPosition 贴右缘留 200px、垂直居中', () => {
    const pos = defaultFloatingPosition(WORK_AREA);
    expect(pos.x).toBe(1920 - PET_FLOATING_WIDTH - 200);
    expect(pos.y).toBe(Math.round((1080 - PET_FLOATING_HEIGHT) / 2));
  });

  it('clampFloatingPosition 把越界坐标夹回工作区', () => {
    const pos = clampFloatingPosition(99999, -999, WORK_AREA);
    expect(pos.x).toBe(WORK_AREA.x + WORK_AREA.width - PET_FLOATING_WIDTH);
    expect(pos.y).toBe(WORK_AREA.y);
  });

  it('clampFloatingPosition 工作区小于冰豆时取工作区边界', () => {
    const tiny = { x: 10, y: 20, width: 100, height: 100 };
    const pos = clampFloatingPosition(0, 0, tiny);
    expect(pos.x).toBe(10);
    expect(pos.y).toBe(20);
  });

  it('resolveFloatingPosition 无持久化坐标时回退默认位', () => {
    const pos = resolveFloatingPosition(WORK_AREA);
    expect(pos.x).toBe(1920 - PET_FLOATING_WIDTH - 200);
    expect(pos.y).toBe(Math.round((1080 - PET_FLOATING_HEIGHT) / 2));
  });
});
